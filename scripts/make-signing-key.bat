@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set "KEYDIR=D:\Programming\shredingerbox-keys"

if exist "%KEYDIR%\shredingerbox.key" (
  echo Ключ уже есть в %KEYDIR% - второй раз не создаю.
  pause
  exit /b 0
)
mkdir "%KEYDIR%" 2>nul

rem Случайный пароль для ключа
for /f %%p in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do set "PASS=%%p"

echo Создаю ключ подписи обновлений...
call npm run tauri signer generate -- --ci -p "%PASS%" -w "%KEYDIR%\shredingerbox.key"
if errorlevel 1 goto fail

> "%KEYDIR%\password.txt" echo %PASS%
echo.
echo Готово! Ключ и пароль лежат в %KEYDIR%
echo Сохрани оба файла в менеджер паролей: без них уже установленные клиенты не смогут обновляться.
pause
exit /b 0

:fail
echo.
echo Не получилось создать ключ. Скопируй текст выше и пришли его в чат.
pause
exit /b 1
