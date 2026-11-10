#!/usr/bin/env bash
# Build reproducible, self-contained Apple Silicon inference workers on macOS.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
test "$(uname -s)" = Darwin && test "$(uname -m)" = arm64 || {
  echo 'A native Apple Silicon macOS builder is required.' >&2; exit 1;
}
export MACOSX_DEPLOYMENT_TARGET=13.5
runtime_root="$project_root/dist/macos-runtime"
work_root="$project_root/target/macos-runtime-build"
mkdir -p "$work_root" "$project_root/dist"
rm -rf "$runtime_root"
mkdir -p "$runtime_root/whisper" "$runtime_root/llama"

checkout_source() {
  local repository="$1" tag="$2" revision="$3" destination="$4"
  local canonical_url="https://github.com/ggml-org/$repository.git"
  if [ ! -d "$destination/.git" ]; then
    git init -q "$destination"
    git -C "$destination" remote add origin "$canonical_url"
  fi
  # Restored build caches must never choose the source repository for a new run.
  git -C "$destination" remote set-url origin "$canonical_url"
  printf 'Fetching %s refs/tags/%s (expected commit %s)\n' "$canonical_url" "$tag" "$revision"
  # Fetch an advertised ref: some Git servers reject shallow fetches by object ID.
  # A moved tag still fails the pinned-commit check before checkout or compilation.
  if ! git -C "$destination" fetch --depth 1 "$canonical_url" "refs/tags/$tag"; then
    printf 'Fetch failed; checking the pinned tag at its canonical upstream.\n' >&2
    git ls-remote --exit-code "$canonical_url" "refs/tags/$tag" "refs/tags/$tag^{}" || true
    return 1
  fi
  test "$(git -C "$destination" rev-parse 'FETCH_HEAD^{commit}')" = "$revision"
  git -C "$destination" checkout --detach "$revision"
  test "$(git -C "$destination" rev-parse HEAD)" = "$revision"
}

checkout_source whisper.cpp v1.7.6 a8d002cfd879315632a579e73f0148d06959de36 "$work_root/whisper-source"
checkout_source llama.cpp b8500 342d6125bcda31f8bbda5df4a74afcf4b2d8c681 "$work_root/llama-source"
common_flags=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" -DBUILD_SHARED_LIBS=ON
  -DGGML_NATIVE=OFF -DGGML_ACCELERATE=ON -DGGML_BLAS=OFF -DGGML_OPENMP=OFF)
cmake -S "$work_root/whisper-source" -B "$work_root/whisper-build" \
  "${common_flags[@]}" -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_COREML=OFF \
  -DWHISPER_CURL=OFF -DWHISPER_FFMPEG=OFF -DWHISPER_SDL2=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=ON
cmake --build "$work_root/whisper-build" --config Release --target whisper-server -j 3
cmake -S "$work_root/llama-source" -B "$work_root/llama-build" \
  "${common_flags[@]}" -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON
cmake --build "$work_root/llama-build" --config Release --target llama-server -j 3

# Copy dereferenced dylibs to each worker's own directory. Their ggml ABIs differ.
node - "$work_root" "$runtime_root" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const [work, runtime] = process.argv.slice(2);
function visit(root) {
  return fs.readdirSync(root).flatMap(name => {
    const file=path.join(root,name), stat=fs.lstatSync(file);
    return stat.isDirectory()?visit(file):[file];
  });
}
for (const worker of ['whisper','llama']) {
  const build=path.join(work,`${worker}-build`), output=path.join(runtime,worker);
  const server=path.join(build,'bin',`${worker}-server`);
  if(!fs.existsSync(server)) throw Error(`Missing built worker ${server}`);
  fs.copyFileSync(server,path.join(output,`${worker}-server`));
  for(const source of visit(build).filter(file=>file.endsWith('.dylib'))) {
    const destination=path.join(output,path.basename(source));
    const data=fs.readFileSync(source);
    if(fs.existsSync(destination)&&!fs.readFileSync(destination).equals(data))throw Error(`Conflicting dylib name ${destination}`);
    fs.writeFileSync(destination,data);
  }
  const names=fs.readdirSync(output);
  for(const name of names) {
    const file=path.join(output,name);
    fs.chmodSync(file,0o755);
    const arch=execFileSync('lipo',['-archs',file],{encoding:'utf8'}).trim();
    if(arch!=='arm64')throw Error(`Unexpected runtime architecture ${name}: ${arch}`);
    if(name.endsWith('.dylib')) execFileSync('install_name_tool',['-id',`@loader_path/${name}`,file]);
    const lines=execFileSync('otool',['-L',file],{encoding:'utf8'}).trim().split('\n').slice(1);
    for(const line of lines) {
      const dependency=line.trim().split(' (')[0];
      const local=path.basename(dependency);
      if(dependency.startsWith('/System/Library/')||dependency.startsWith('/usr/lib/'))continue;
      if(!names.includes(local))throw Error(`Unbundled dependency in ${name}: ${dependency}`);
      execFileSync('install_name_tool',['-change',dependency,`@loader_path/${local}`,file]);
    }
  }
  // Relocation changes Mach-O bytes, so sign only after all edits are complete.
  for(const name of names)execFileSync('codesign',['--force','--sign','-','--timestamp=none',path.join(output,name)]);
}
NODE

"$runtime_root/whisper/whisper-server" --help > "$project_root/dist/macos-whisper-help.txt" 2>&1
"$runtime_root/llama/llama-server" --help > "$project_root/dist/macos-llama-help.txt" 2>&1
# A hosted macOS VM may expose no Metal GPU. Capture discovery without claiming inference.
"$runtime_root/llama/llama-server" --list-devices > "$project_root/dist/macos-devices.txt" 2>&1 || true
mkdir -p "$project_root/dist/macos-runtime-licenses"
cp "$work_root/whisper-source/LICENSE" "$project_root/dist/macos-runtime-licenses/whisper.cpp-LICENSE"
cp "$work_root/llama-source/LICENSE" "$project_root/dist/macos-runtime-licenses/llama.cpp-LICENSE"
node - "$runtime_root" "$project_root/dist/macos-runtime-manifest.json" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [root,output]=process.argv.slice(2);const files=[];
for(const worker of ['whisper','llama'])for(const name of fs.readdirSync(path.join(root,worker)).sort()) {
 const file=path.join(root,worker,name),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink())throw Error('Runtime must contain ordinary files');
 files.push({path:`${worker}/${name}`,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),size_bytes:stat.size});
}
fs.writeFileSync(output,JSON.stringify({format_version:1,files},null,2)+'\n');
console.log(`Validated and signed ${files.length} native arm64 runtime files`);
NODE
