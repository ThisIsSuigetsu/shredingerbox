@echo off
chcp 65001 >nul
cd /d "%~dp0"
set /p VERSION="Новая версия (например 0.5.1): "
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" %VERSION%
pause
