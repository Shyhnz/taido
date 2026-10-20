fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // cpal links two CoreAudio functions that exist only on macOS 14.2+: weak-link the
        // framework so Taido still launches on older macOS (minimum 10.15). Same as Handy.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,CoreAudio");
        link_clang_rt_osx();
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_windows_manifest();
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("tauri build script failed");
    } else {
        tauri_build::build()
    }
}

/// Embeds the Common-Controls v6 manifest in every executable of this crate, tests included.
///
/// tauri-build only attaches its manifest to the app binary, so the unit-test executable of
/// the library fails to start on Windows (`STATUS_ENTRYPOINT_NOT_FOUND`, comctl32 v5 lacks
/// `TaskDialogIndirect`). The same manifest content as tauri-build's, linked into all targets.
fn embed_windows_manifest() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set"));
    let manifest = out_dir.join("taido.manifest");
    std::fs::write(
        &manifest,
        r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
    )
    .expect("write the Windows manifest");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

/// Links clang's compiler runtime, which provides `__isPlatformVersionAtLeast`.
///
/// ggml-metal (dictation, transcribe-cpp) guards newer Metal APIs with `@available`. With a
/// deployment target older than the SDK, clang lowers those checks to calls into
/// `libclang_rt.osx.a`, which rustc does not link (`-nodefaultlibs`). Taken from Handy (MIT),
/// src-tauri/build.rs.
fn link_clang_rt_osx() {
    let output = std::process::Command::new("clang")
        .arg("--print-resource-dir")
        .output()
        .expect("run `clang --print-resource-dir` to locate libclang_rt.osx.a");
    assert!(
        output.status.success(),
        "`clang --print-resource-dir` failed; cannot locate libclang_rt.osx.a"
    );
    let resource_dir = String::from_utf8(output.stdout).expect("clang resource dir is UTF-8");
    let darwin_dir = std::path::Path::new(resource_dir.trim()).join("lib/darwin");
    assert!(
        darwin_dir.join("libclang_rt.osx.a").exists(),
        "libclang_rt.osx.a not found in {}",
        darwin_dir.display()
    );
    println!("cargo:rustc-link-search=native={}", darwin_dir.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
