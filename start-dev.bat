@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "BIN=src-tauri\binaries\sing-box-x86_64-pc-windows-msvc.exe"

if not exist "%BIN%" (
  echo [1/3] Скачиваю ядро sing-box с GitHub...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-sing-box.ps1"
  if errorlevel 1 goto fail
) else (
  echo [1/3] Ядро sing-box уже на месте
)

where cursor >nul 2>nul && start "" cursor "%~dp0"

echo [2/3] Устанавливаю зависимости npm...
call npm install
if errorlevel 1 goto fail

echo [3/3] Запускаю ShredingerBox. Первая сборка Rust идёт 5-15 минут, это нормально.
call npm run tauri dev
pause
exit /b 0

:fail
echo.
echo Что-то пошло не так. Скопируй текст выше и пришли его в чат.
pause
exit /b 1
