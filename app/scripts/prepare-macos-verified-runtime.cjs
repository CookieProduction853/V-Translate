// Reuse an immutable, natively tested binary only when every compiled input is unchanged.
// This is a native macOS validation path, not a cross-compiled replacement build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const binarySource = '6f1e121f184d5492bcac816b365d435ea361f12d';
const artifactCommit = '1f5d4c40dadcc70a707aacdf5604b396f4657441';
const archiveSha = 'f5e273a3f93bcb04de538285c3db9681b1253d3950abaa9cc1b19861cb4a2c40';
const compiledInputs = ['src', 'web', 'assets', 'Cargo.toml', 'Cargo.lock', 'build.rs'];
const project = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const archive = path.resolve(process.argv[2]);
assert.equal(sha(fs.readFileSync(archive)), archiveSha, 'The immutable baseline archive must match its pinned checksum');
assert.equal(git('rev-parse', binarySource).trim(), binarySource);
git('diff', '--exit-code', binarySource, 'HEAD', '--', ...compiledInputs);
const oldInputs = git('ls-tree', '-r', binarySource, '--', ...compiledInputs);
assert.equal(git('ls-tree', '-r', 'HEAD', '--', ...compiledInputs), oldInputs, 'Compiled source, assets and lockfile must be byte-identical');
const baseline = JSON.parse(git('show', `${artifactCommit}:BUILD_REPORT.json`));
assert.equal(baseline.source_commit, binarySource);
assert.equal(baseline.platform, 'darwin');
assert.equal(baseline.architecture, 'arm64');
assert.equal(baseline.inference.cpu, 'passed');
assert.equal(baseline.inference.metal, 'passed');
const oldUnitLog = git('show', `${artifactCommit}:macos-cargo-test.log`);
assert.match(oldUnitLog, /68 passed; 0 failed/);

function visit(folder) {
  return fs.readdirSync(folder).sort().flatMap(name => {
    const file = path.join(folder, name), stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink(), `Unexpected baseline symlink: ${name}`);
    return stat.isDirectory() ? visit(file) : [file];
  });
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vtranslate-verified-baseline-'));
try {
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, temporary]);
  const root = path.join(temporary, 'V-Translate-macOS-arm64');
  for (const line of fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/); assert.ok(match, 'Invalid baseline checksum entry');
    assert.ok(!path.isAbsolute(match[2]) && !match[2].split('/').includes('..'));
    assert.equal(sha(fs.readFileSync(path.join(root, match[2]))), match[1], `Baseline file changed: ${match[2]}`);
  }
  const app = path.join(root, 'V-Translate.app');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  const resources = path.join(app, 'Contents/Resources');
  const runtime = path.join(resources, 'runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.format_version, 1);
  const expected = new Set();
  for (const entry of manifest.files) {
    assert.match(entry.path, /^(whisper|llama)\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);
    assert.ok(!expected.has(entry.path)); expected.add(entry.path);
    const file = path.join(runtime, entry.path), bytes = fs.readFileSync(file);
    assert.equal(bytes.length, entry.size_bytes); assert.equal(sha(bytes), entry.sha256);
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf); assert.equal(bytes.readUInt32LE(4), 0x0100000c);
  }
  assert.deepEqual(new Set(visit(runtime).map(file => path.relative(runtime, file))), expected);
  const binary = path.join(app, 'Contents/MacOS/V-Translate');
  const binaryBytes = fs.readFileSync(binary);
  assert.equal(binaryBytes.readUInt32LE(0), 0xfeedfacf);
  assert.equal(binaryBytes.readUInt32LE(4), 0x0100000c);
  assert.equal(binaryBytes.readUInt32LE(12), 2);
  const outputBinary = path.join(project, 'target/aarch64-apple-darwin/release/livesub');
  fs.mkdirSync(path.dirname(outputBinary), { recursive: true });
  fs.copyFileSync(binary, outputBinary); fs.chmodSync(outputBinary, 0o755);
  const dist = path.join(project, 'dist'); fs.mkdirSync(dist, { recursive: true });
  for (const [source, destination] of [[runtime, 'macos-runtime'], [path.join(resources, 'licenses'), 'macos-runtime-licenses']]) {
    const output = path.join(dist, destination);
    fs.rmSync(output, { recursive: true, force: true });
    fs.cpSync(source, output, { recursive: true, preserveTimestamps: true });
  }
  fs.copyFileSync(path.join(resources, 'runtime-manifest.json'), path.join(dist, 'macos-runtime-manifest.json'));
  fs.copyFileSync(path.join(root, 'THIRD_PARTY_LICENSES.txt'), path.join(project, 'THIRD_PARTY_LICENSES.txt'));
  fs.writeFileSync(path.join(dist, 'macos-binary-provenance.json'), JSON.stringify({
    format_version: 1,
    source_commit: git('rev-parse', 'HEAD').trim(),
    binary_source_commit: binarySource,
    baseline_artifact_commit: artifactCommit,
    baseline_archive_sha256: archiveSha,
    binary_sha256: sha(binaryBytes),
    compiled_inputs: compiledInputs,
    compiled_inputs_git_tree_sha256: sha(oldInputs),
    source_equivalence: 'Exact git tree entries match for all Rust source, embedded web/assets, Cargo manifest/lockfile and build.rs.',
    original_unit_tests: '68 passed; 0 failed on native Apple Silicon; log retained with original binary source provenance.',
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP || temporary, 'macos-cargo-test.log'), `Reused native unit-test evidence for byte-identical compiled inputs.\nBinary source: ${binarySource}\nArtifact: ${artifactCommit}\n${oldUnitLog}`);
  console.log('PASS immutable native baseline checksum, code signature, runtime hashes, ARM64 binary and exact compiled-input equivalence');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
