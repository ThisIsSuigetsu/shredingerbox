# Выпуск ShredingerBox через GitHub

Репозиторий: https://github.com/ThisIsSuigetsu/shredingerbox (публичный).
GitHub Actions собирает Windows и macOS, подписывает обновления и публикует релиз с `latest.json`.
Установленные клиенты сами находят новую версию и предлагают обновиться.

## Один раз: настройка

1. **Git.** В терминале от имени администратора: `choco install git -y`
   (или поставь GitHub Desktop). Потом открой новый терминал.

2. **Репозиторий.** На https://github.com/new создай `shredingerbox`, **Public**,
   без README, .gitignore и лицензии - пустой.

3. **Ключ подписи обновлений.** В терминале в папке проекта:

   ```powershell
   npm run tauri signer generate -- -w "$env:USERPROFILE\.tauri\shredingerbox.key"
   ```

   Придумай пароль. Появятся два файла:
   - `shredingerbox.key` - **приватный**. Сохрани его и пароль в менеджер паролей.
     Потеряешь - уже установленные клиенты не смогут обновиться.
   - `shredingerbox.key.pub` - публичный.

4. **Публичный ключ в конфиг.** Открой `shredingerbox.key.pub` блокнотом, скопируй всё
   и вставь в `src-tauri/tauri.conf.json` вместо `ВСТАВЬ_СЮДА_ПУБЛИЧНЫЙ_КЛЮЧ…`
   (`plugins` → `updater` → `pubkey`).

5. **Секреты в GitHub.** Репозиторий → Settings → Secrets and variables → Actions →
   New repository secret:
   - `TAURI_SIGNING_PRIVATE_KEY` - всё содержимое файла `shredingerbox.key`;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - пароль от ключа.

6. **Первая отправка.** В терминале в папке проекта:

   ```powershell
   git init
   git add -A
   git commit -m "ShredingerBox 0.5.0"
   git branch -M main
   git remote add origin https://github.com/ThisIsSuigetsu/shredingerbox.git
   git push -u origin main
   git tag v0.5.0
   git push origin v0.5.0
   ```

   При первом `git push` откроется окно входа в GitHub - войди в аккаунт.

7. **Дождись сборки** на вкладке Actions (10-15 минут). Релиз появится на вкладке Releases.
   Версию 0.5.0 **один раз поставь вручную** себе и друзьям - в старых версиях автообновления ещё нет.

8. **Лицензия.** Repo → Add file → Create new file → имя `LICENSE` → «Choose a license template» → GPL-3.0.

## Каждый следующий выпуск

1. Поменял код, проверил через `start-dev.bat`.
2. Дважды щёлкни `release.bat`, введи новую версию (например `0.5.1`).
3. Через 10-15 минут клиенты предложат обновиться.

## Что важно знать

- Описание релиза берётся из раздела этой версии в `CHANGELOG.md` (`## 0.6.1`). Его видно на GitHub
  и в окне «Доступна версия», а после обновления клиент один раз показывает «Что нового».
  Поэтому перед `release.bat` допиши раздел новой версии. Английский раздел той же версии - в
  `CHANGELOG.en.md`: на GitHub он идёт после строки **English**, а клиент на английском показывает только его.
- Кроме установщика, в каждый релиз попадает `ShredingerBox_…_x64-portable.zip` (`scripts/make-portable.ps1`).

- Версия sing-box и её SHA256 записаны в `scripts/sing-box.pin`, GitHub Actions в `release.yml`
  закреплены по хешам коммитов. Сами они не обновляются. `release.bat` перед выпуском показывает,
  что вышло новое (`scripts/check-updates.ps1`). Перед обновлением проверь, не было ли новостей о взломе
  проекта. sing-box обновляется командой `scripts\update-sing-box.ps1 1.14.5`, Rust - строкой
  `toolchain:` в `release.yml`. Новые версии Actions раз в месяц приносит Dependabot отдельным
  pull request - принимать его только после проверки.
- Ключи `.key` в репозиторий не попадают: они в `.gitignore`.
- Подписки друзей хранятся у них на компьютерах, в репозитории их нет.
- macOS-сборка подписана только ad-hoc (`signingIdentity: "-"` в `tauri.ci.conf.json`), без платного
  сертификата Apple. Без этой подписи macOS на M1+ называет приложение «повреждённым». Первый запуск -
  правый клик → «Открыть» или «Всё равно открыть» в настройках безопасности, подробности в `FRIENDS.md`.
  На Mac «Прокси» включает системный прокси через `networksetup`, а TUN запускает ядро от root через
  `osascript … with administrator privileges` (пароль при каждом подключении). Автозапуска на Mac нет.
