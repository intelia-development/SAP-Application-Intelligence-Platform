@echo off
echo 🚀 Building and Installing ABAP Intelligence Extension...
echo ⏰ Build started at %TIME% on %DATE%
set start_time=%TIME%

echo 📋 Reading version from package.json...
for /f "delims=" %%i in ('powershell -Command "(Get-Content package.json | ConvertFrom-Json).version"') do set VERSION=%%i
echo 📌 Version: %VERSION%

echo 📦 Compiling TypeScript...
call npm run compile
if %errorlevel% neq 0 (
    echo ❌ Compilation failed!
    pause
    exit /b 1
)
echo ✅ Compilation successful!

echo 📦 Packaging extension...
call npx vsce package --allow-star-activation --allow-missing-repository --out "INTELIA-SAP-Application-Intelligence-Platform-v%VERSION%.vsix" 
if %errorlevel% neq 0 (
    echo ❌ Packaging failed!
    pause
    exit /b 1
)
echo ✅ Packaging successful!

echo 🔧 Installing extension to VS Code...
call code --install-extension "INTELIA-SAP-Application-Intelligence-Platform-v%VERSION%.vsix" --force
if %errorlevel% neq 0 (
    echo ❌ Installation failed!
    pause
    exit /b 1
)
echo ✅ Extension installed successfully!

echo 🎉 ABAP Intelligence Extension is ready to use!
set end_time=%TIME%
echo ⏰ Build started at %start_time%
echo ⏰ Build completed at %end_time%
echo 💡 Restart VS Code or reload the window (Ctrl+Shift+P ^> 'Developer: Reload Window') to use the updated extension.
pause
