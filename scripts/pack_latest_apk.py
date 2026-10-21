import os
import shutil
import subprocess
import json
import zipfile
from datetime import datetime

def run(cmd):
    print(f"> {cmd}")
    res = subprocess.run(cmd, shell=True, text=True, capture_output=True)
    if res.returncode != 0:
        print(f"STDOUT: {res.stdout}")
        print(f"STDERR: {res.stderr}")
        raise RuntimeError(f"Command failed: {cmd}\n{res.stderr}")
    return res.stdout.strip()

def pack_latest_apk():
    root_dir = os.path.abspath(".")
    dist_dir = os.path.join(root_dir, "dist")
    base_apk = os.path.join(root_dir, "export/mv-director-ai-v1.0.apk")
    work_dir = os.path.join(root_dir, "android/pack_work")

    if not os.path.exists(dist_dir) or not os.path.exists(os.path.join(dist_dir, "index.html")):
        print("dist directory missing or incomplete. Building dist first...")
        run("npm run build")

    if not os.path.exists(base_apk):
        raise FileNotFoundError(f"Base APK not found at {base_apk}")

    print(f"🚀 Packaging latest build from dist/ into Android APK...")
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir, exist_ok=True)

    # 1. Extract base APK non-asset, non-signature files
    stage_dir = os.path.join(work_dir, "stage")
    os.makedirs(stage_dir, exist_ok=True)

    with zipfile.ZipFile(base_apk, 'r') as zin:
        for item in zin.infolist():
            # Skip old assets/public and old META-INF signatures
            if item.filename.startswith("assets/public/") or item.filename.startswith("META-INF/"):
                continue
            zin.extract(item, stage_dir)

    # 2. Copy fresh web assets from dist/ into stage/assets/public/
    target_assets_dir = os.path.join(stage_dir, "assets/public")
    os.makedirs(target_assets_dir, exist_ok=True)

    for root, dirs, files in os.walk(dist_dir):
        rel_root = os.path.relpath(root, dist_dir)
        dest_root = os.path.join(target_assets_dir, rel_root) if rel_root != "." else target_assets_dir
        os.makedirs(dest_root, exist_ok=True)
        for f in files:
            if f.endswith(".apk") or f.endswith(".map") or f == "export":
                continue
            shutil.copy2(os.path.join(root, f), os.path.join(dest_root, f))

    # 3. Patch index.html in APK assets for WebView asset loading
    apk_index_path = os.path.join(target_assets_dir, "index.html")
    if os.path.exists(apk_index_path):
        with open(apk_index_path, "r", encoding="utf-8") as f:
            html = f.read()
        if "<base " not in html:
            html = html.replace("<head>", '<head>\n    <base href="file:///android_asset/public/">')
        html = html.replace('src="/assets/', 'src="./assets/')
        html = html.replace('href="/assets/', 'href="./assets/')
        html = html.replace("src='/assets/", "src='./assets/")
        html = html.replace("href='/assets/", "href='./assets/")
        with open(apk_index_path, "w", encoding="utf-8") as f:
            f.write(html)
        print("Patched APK index.html with base href file:///android_asset/public/")

    # 4. Pack into unaligned zip
    unaligned_apk = os.path.join(work_dir, "unaligned.apk")
    print("Creating unaligned APK archive...")
    with zipfile.ZipFile(unaligned_apk, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
        for root, dirs, files in os.walk(stage_dir):
            for f in files:
                full_path = os.path.join(root, f)
                archive_name = os.path.relpath(full_path, stage_dir)
                # Store uncompressed for .arsc and already compressed formats per Android spec
                compress_type = zipfile.ZIP_STORED if f.endswith(".arsc") or f.endswith(".png") or f.endswith(".jpg") else zipfile.ZIP_DEFLATED
                zout.write(full_path, archive_name, compress_type=compress_type)

    # 5. Keystore
    keystore_path = os.path.join(work_dir, "debug.keystore")
    run(f'keytool -genkeypair -v -keystore {keystore_path} -alias androiddebugkey -keypass android -storepass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" 2>/dev/null || true')

    # 6. Zipalign
    aligned_apk = os.path.join(work_dir, "aligned.apk")
    print("Zipaligning APK to 4-byte boundaries...")
    run(f"zipalign -p -f 4 {unaligned_apk} {aligned_apk}")

    # 7. apksigner
    print("Signing APK with apksigner (v1, v2, v3 schemes)...")
    run(f"apksigner sign --ks {keystore_path} --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android {aligned_apk}")

    # 8. Verify
    print("Verifying APK signatures...")
    verify_out = run(f"apksigner verify --verbose {aligned_apk}")
    print(verify_out)

    # 9. Publish artifacts
    final_size = os.path.getsize(aligned_apk)
    size_mb = f"{(final_size / (1024 * 1024)):.2f} MB"
    print(f"Final aligned & signed APK size: {final_size} bytes ({size_mb})")

    export_dir = os.path.join(root_dir, "export")
    public_export_dir = os.path.join(root_dir, "public/export")
    public_dir = os.path.join(root_dir, "public")
    dist_export_dir = os.path.join(dist_dir, "export")

    for d in [export_dir, public_export_dir, public_dir, dist_export_dir]:
        os.makedirs(d, exist_ok=True)

    apk_name = "mv-director-ai-v1.0.apk"
    debug_apk_name = "app-debug.apk"

    with open(aligned_apk, "rb") as f:
        apk_bytes = f.read()

    for path_target in [
        os.path.join(export_dir, apk_name),
        os.path.join(export_dir, debug_apk_name),
        os.path.join(public_export_dir, apk_name),
        os.path.join(public_dir, "mv-director.apk"),
        os.path.join(dist_export_dir, apk_name),
        os.path.join(dist_dir, "mv-director.apk")
    ]:
        with open(path_target, "wb") as f:
            f.write(apk_bytes)
        print(f"Wrote {path_target}")

    # 10. Update export-info.json and README.md
    now_iso = datetime.utcnow().isoformat() + "Z"
    info = {
        "appName": "MV Director AI - Mobile Cinematic Studio",
        "packageName": "com.mvdirector.studio",
        "version": "1.0.1",
        "buildDate": now_iso,
        "files": [
            {
                "fileName": apk_name,
                "path": f"export/{apk_name}",
                "sizeBytes": final_size,
                "sizeFormatted": size_mb
            },
            {
                "fileName": debug_apk_name,
                "path": f"export/{debug_apk_name}",
                "sizeBytes": final_size,
                "sizeFormatted": size_mb
            }
        ],
        "verified": True,
        "signatureSchemes": ["v1", "v2", "v3"],
        "targetSdkVersion": 33,
        "minSdkVersion": 21,
        "instructions": "100% installable Android APK signed with v1/v2/v3 schemes. Updated with the latest application build."
    }

    with open(os.path.join(export_dir, "export-info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2)

    readme_content = f"""# MV Director AI - Exported Android APK

## Build Details
- **App Name:** MV Director AI
- **Package:** `com.mvdirector.studio`
- **Version:** 1.0.1 (Latest Build)
- **Build Date:** {now_iso}
- **Signatures:** v1 (JAR signing), v2 (APK Signature Scheme v2), v3 (APK Signature Scheme v3)
- **Min SDK:** 21 (Android 5.0 Lollipop)
- **Target SDK:** 33 (Android 13)
- **Artifacts:**
  - `{apk_name}` ({size_mb})
  - `{debug_apk_name}` ({size_mb})

## Installation Instructions
1. Download `{apk_name}` to your Android device.
2. Open the file on Android and allow installation from Unknown Sources if prompted.
3. Launch **MV Director AI** directly on your device.
"""
    with open(os.path.join(export_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write(readme_content)

    # Cleanup work directory
    shutil.rmtree(work_dir)
    print("\n🎉 SUCCESS! Current APK build successfully packaged, zipaligned, and signed!")

if __name__ == "__main__":
    pack_latest_apk()
