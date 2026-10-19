fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // cpal links two CoreAudio functions that exist only on macOS 14.2+: weak-link the
        // framework so Taido still launches on older macOS (minimum 10.15). Same as Handy.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,CoreAudio");
        link_clang_rt_osx();
    }
    tauri_build::build()
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
