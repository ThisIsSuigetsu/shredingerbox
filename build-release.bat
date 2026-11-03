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

echo [2/3] Устанавливаю зависимости npm...
call npm install
if errorlevel 1 goto fail

echo [3/3] Собираю установщик. Первая релизная сборка идёт 5-10 минут.
call npm run tauri build
if errorlevel 1 goto fail

echo.
echo Готово! Открываю папку с установщиком.
explorer "%~dp0src-tauri\target\release\bundle\nsis"
pause
exit /b 0

:fail
echo.
echo Сборка не удалась. Скопируй текст выше и пришли его в чат.
pause
exit /b 1
