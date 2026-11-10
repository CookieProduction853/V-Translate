use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=assets/app-icon.png");
    println!("cargo:rerun-if-changed=assets/TASK BAR ICON.png");
    println!("cargo:rerun-if-changed=assets/app-icon.ico");
    println!("cargo:rerun-if-changed=assets/windows.rc");
    println!("cargo:rerun-if-env-changed=RC");
    println!("cargo:rerun-if-env-changed=WINDRES");
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let assets = root.join("assets");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    println!("cargo:rerun-if-env-changed=VTRANSLATE_MACOS_RUNTIME_MANIFEST");
    let mac_manifest = match env::var_os("VTRANSLATE_MACOS_RUNTIME_MANIFEST") {
        Some(path) => {
            println!("cargo:rerun-if-changed={}", PathBuf::from(&path).display());
            fs::read(path).expect("could not read macOS runtime manifest")
        }
        None => Vec::new(),
    };
    fs::write(output.join("macos-runtime-manifest.json"), mac_manifest)
        .expect("could not stage macOS runtime manifest");
    // Keep these include_bytes! paths available on every platform. An empty
    // asset means the original artwork has not been supplied yet; the HTTP
    // route can then return 404 instead of displaying substitute artwork.
    for name in ["app-icon.png", "app-icon.ico"] {
        let source = if name == "app-icon.png" && assets.join("TASK BAR ICON.png").is_file() {
            assets.join("TASK BAR ICON.png")
        } else {
            assets.join(name)
        };
        let bytes = match fs::read(&source) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => panic!("could not read {}: {error}", source.display()),
        };
        fs::write(output.join(name), bytes).expect("could not stage application icon");
    }
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    if !assets.join("app-icon.ico").is_file() {
        println!(
            "cargo:warning=assets/app-icon.ico is missing; Windows icon resource was not embedded"
        );
        return;
    }
    let version = env::var("CARGO_PKG_VERSION").unwrap();
    let numbers: Vec<u16> = version
        .split('.')
        .map(|part| part.parse().unwrap())
        .collect();
    assert_eq!(
        numbers.len(),
        3,
        "Windows releases require major.minor.patch"
    );
    let resource_source = output.join("application.rc");
    let metadata = format!(
        r#"
1 VERSIONINFO
FILEVERSION {major},{minor},{patch},0
PRODUCTVERSION {major},{minor},{patch},0
FILEFLAGSMASK 0x3fL
FILEFLAGS 0x0L
FILEOS 0x40004L
FILETYPE 0x1L
FILESUBTYPE 0x0L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904B0"
        BEGIN
            VALUE "FileDescription", "V-Translate\0"
            VALUE "FileVersion", "{version}.0\0"
            VALUE "InternalName", "V-Translate\0"
            VALUE "OriginalFilename", "V-Translate.exe\0"
            VALUE "ProductName", "V-Translate\0"
            VALUE "ProductVersion", "{version}.0\0"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x0409, 1200
    END
END
"#,
        major = numbers[0],
        minor = numbers[1],
        patch = numbers[2],
    );
    fs::write(
        &resource_source,
        format!("{}{}", include_str!("assets/windows.rc"), metadata),
    )
    .expect("could not write Windows version resource");
    let target = env::var("TARGET").unwrap();
    let resource = if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let resource = output.join("app-icon.res");
        let compiler = find_rc();
        run(Command::new(compiler)
            .arg("/nologo")
            .arg("/fo")
            .arg(&resource)
            .arg("/I")
            .arg(&assets)
            .arg(&resource_source));
        resource
    } else {
        let resource = output.join("app-icon.o");
        let compiler = env::var_os("WINDRES").or_else(|| env::var_os("RC"));
        let compiler = compiler.unwrap_or_else(|| {
            let prefix = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
                Ok("x86_64") => "x86_64-w64-mingw32",
                Ok("x86") => "i686-w64-mingw32",
                Ok("aarch64") => "aarch64-w64-mingw32",
                _ => panic!("set WINDRES to a resource compiler for {target}"),
            };
            format!("{prefix}-windres").into()
        });
        run(Command::new(compiler)
            .arg("--input-format=rc")
            .arg("--output-format=coff")
            .arg("--include-dir")
            .arg(&assets)
            .arg("--input")
            .arg(&resource_source)
            .arg("--output")
            .arg(&resource));
        resource
    };
    println!("cargo:rustc-link-arg-bins={}", resource.display());
}

fn run(command: &mut Command) {
    let status = command.status().unwrap_or_else(|error| {
        panic!("could not start Windows resource compiler {command:?}: {error}")
    });
    assert!(
        status.success(),
        "Windows resource compiler failed: {command:?}"
    );
}

fn find_rc() -> PathBuf {
    if let Some(compiler) = env::var_os("RC") {
        return compiler.into();
    }
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            let compiler = directory.join("rc.exe");
            if compiler.is_file() {
                return compiler;
            }
        }
    }
    // The Windows SDK is installed on the release runner, even when its tools
    // have not been added to PATH by a Visual Studio developer shell.
    let arch = match env::var("HOST").unwrap_or_default().split('-').next() {
        Some("aarch64") => "arm64",
        Some("i686") => "x86",
        _ => "x64",
    };
    let sdk = env::var_os("WindowsSdkDir").map(PathBuf::from).or_else(|| {
        env::var_os("ProgramFiles(x86)").map(|p| PathBuf::from(p).join("Windows Kits/10"))
    });
    if let Some(sdk) = sdk {
        let mut versions: Vec<_> = fs::read_dir(sdk.join("bin"))
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect();
        versions.sort();
        for version in versions.into_iter().rev() {
            let compiler = version.join(arch).join("rc.exe");
            if compiler.is_file() {
                return compiler;
            }
        }
    }
    panic!("Windows SDK rc.exe was not found; install the Windows SDK or set RC");
}
