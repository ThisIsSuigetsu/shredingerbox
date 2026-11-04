//! Системные вещи Windows: права администратора, системный прокси,
//! список запущенных программ, открытие папки. На macOS - системный прокси через
//! networksetup, остальное - заглушки.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct ProcInfo {
    pub name: String,
    pub exe: String,
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "wininet")]
    extern "system" {
        fn InternetSetOptionW(h: *mut c_void, option: u32, buf: *mut c_void, len: u32) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> *mut c_void;
    }

    const INTERNET_OPTION_REFRESH: u32 = 37;
    const INTERNET_OPTION_SETTINGS_CHANGED: u32 = 39;

    pub fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Сообщить системе и браузерам, что настройки прокси поменялись.
    pub fn refresh_inet() {
        unsafe {
            InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null_mut(), 0);
            InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_REFRESH, std::ptr::null_mut(), 0);
        }
    }

    /// Запустить программу с запросом UAC. true - пользователь согласился.
    pub fn run_elevated(exe: &std::path::Path, args: &str) -> bool {
        let op = wide(std::ffi::OsStr::new("runas"));
        let file = wide(exe.as_os_str());
        let params = wide(std::ffi::OsStr::new(args));
        let res = unsafe {
            ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), file.as_ptr(), params.as_ptr(), std::ptr::null(), 1)
        };
        res as usize > 32
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::process::Command;

    const NETWORKSETUP: &str = "/usr/sbin/networksetup";

    /// Включённые сетевые службы («Wi-Fi», «Ethernet»). Первая строка вывода - пояснение,
    /// выключенные службы помечены «*».
    fn services() -> Vec<String> {
        let Ok(out) = Command::new(NETWORKSETUP).arg("-listallnetworkservices").output() else {
            return vec![];
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .skip(1)
            .filter(|l| !l.trim().is_empty() && !l.starts_with('*'))
            .map(str::to_string)
            .collect()
    }

    /// networksetup пишет ошибки в stdout и не всегда меняет код выхода.
    fn run(args: &[&str]) -> Result<(), String> {
        let out = Command::new(NETWORKSETUP).args(args).output().map_err(|e| e.to_string())?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if out.status.success() && !text.contains("Error") {
            Ok(())
        } else {
            Err(text.trim().to_string())
        }
    }

    /// Выполнить команды для каждой службы. Хватает, чтобы сработало хотя бы на одной.
    fn for_each_service(cmds: impl Fn(&str) -> Vec<Vec<String>>) -> Result<(), String> {
        let list = services();
        if list.is_empty() {
            return Err(crate::i18n::tr("Не нашлось ни одного сетевого подключения", "No network connections found").into());
        }
        let mut ok = false;
        let mut last_err = String::new();
        for svc in &list {
            let res = cmds(svc)
                .iter()
                .try_for_each(|c| run(&c.iter().map(String::as_str).collect::<Vec<_>>()));
            match res {
                Ok(()) => ok = true,
                Err(e) => last_err = e,
            }
        }
        if ok {
            Ok(())
        } else {
            Err(format!("{}: {last_err}", crate::i18n::tr("macOS не дала изменить системный прокси", "macOS did not allow changing the system proxy")))
        }
    }

    pub fn set_proxy(port: u16) -> Result<(), String> {
        let port = port.to_string();
        for_each_service(|svc| {
            let s = svc.to_string();
            let p = port.clone();
            let mut bypass = vec!["-setproxybypassdomains".to_string(), s.clone()];
            bypass.extend(
                ["localhost", "127.0.0.1", "*.local", "169.254/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
                    .map(String::from),
            );
            vec![
                vec!["-setwebproxy".into(), s.clone(), "127.0.0.1".into(), p.clone()],
                vec!["-setsecurewebproxy".into(), s.clone(), "127.0.0.1".into(), p.clone()],
                vec!["-setsocksfirewallproxy".into(), s, "127.0.0.1".into(), p],
                bypass,
            ]
        })
    }

    pub fn clear_proxy() -> Result<(), String> {
        for_each_service(|svc| {
            ["-setwebproxystate", "-setsecurewebproxystate", "-setsocksfirewallproxystate"]
                .iter()
                .map(|cmd| vec![cmd.to_string(), svc.to_string(), "off".into()])
                .collect()
        })
    }
}

pub fn is_elevated() -> bool {
    #[cfg(windows)]
    {
        is_elevated::is_elevated()
    }
    #[cfg(not(windows))]
    {
        true
    }
}

const INET_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const BYPASS: &str = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*;<local>";

pub fn set_system_proxy(port: u16) -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(INET_KEY)
            .map_err(|e| format!("{}: {e}", crate::i18n::tr("Не удалось открыть настройки прокси", "Could not open proxy settings")))?;
        key.set_value("ProxyServer", &format!("127.0.0.1:{port}"))
            .map_err(|e| e.to_string())?;
        key.set_value("ProxyOverride", &BYPASS.to_string())
            .map_err(|e| e.to_string())?;
        key.set_value("ProxyEnable", &1u32).map_err(|e| e.to_string())?;
        win::refresh_inet();
    }
    #[cfg(target_os = "macos")]
    mac::set_proxy(port)?;
    #[cfg(not(windows))]
    let _ = (port, INET_KEY, BYPASS);
    Ok(())
}

pub fn clear_system_proxy() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(INET_KEY)
            .map_err(|e| e.to_string())?;
        key.set_value("ProxyEnable", &0u32).map_err(|e| e.to_string())?;
        win::refresh_inet();
    }
    #[cfg(target_os = "macos")]
    mac::clear_proxy()?;
    Ok(())
}

/// Перезапуск клиента с правами администратора (для TUN).
pub fn restart_as_admin() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(win::run_elevated(&exe, "--autoconnect"))
    }
    #[cfg(not(windows))]
    {
        Err(crate::i18n::tr("Перезапуск с правами администратора есть только в Windows", "Restarting as administrator is only available on Windows").into())
    }
}

/// Программы, у которых есть окно - их пользователь и узнает в списке.
pub fn list_processes() -> Vec<ProcInfo> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \
            Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | \
            Select-Object ProcessName, Path, Description | ConvertTo-Json -Compress";
        let out = match std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) => o,
            Err(_) => return vec![],
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let value: serde_json::Value = match serde_json::from_str(text.trim()) {
            Ok(v) => v,
            Err(_) => return vec![],
        };
        let items = match value {
            serde_json::Value::Array(a) => a,
            other => vec![other],
        };
        let mut result: Vec<ProcInfo> = vec![];
        for item in items {
            let pname = item["ProcessName"].as_str().unwrap_or_default();
            if pname.is_empty() || pname.eq_ignore_ascii_case("ShredingerBox") {
                continue;
            }
            let exe = item["Path"]
                .as_str()
                .and_then(|p| std::path::Path::new(p).file_name())
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("{pname}.exe"));
            let name = item["Description"]
                .as_str()
                .filter(|d| !d.trim().is_empty())
                .unwrap_or(pname)
                .to_string();
            if !result.iter().any(|r| r.exe.eq_ignore_ascii_case(&exe)) {
                result.push(ProcInfo { name, exe });
            }
        }
        result.sort_by_key(|p| p.name.to_lowercase());
        result
    }
    #[cfg(not(windows))]
    {
        vec![]
    }
}

/// В 0.4-dev клиент регистрировал схему shredingerbox:// - убираем её из реестра.
pub fn remove_legacy_url_scheme() {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(r"Software\Classes\shredingerbox");
    }
}

// ---------- одна копия программы ----------

#[cfg(windows)]
mod single {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attrs: *mut c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
        fn GetLastError() -> u32;
        fn CloseHandle(h: *mut c_void) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> *mut c_void;
        fn ShowWindow(hwnd: *mut c_void, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: *mut c_void) -> i32;
    }

    const ERROR_ALREADY_EXISTS: u32 = 183;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// true - мы единственная копия (мьютекс остаётся открытым до выхода из программы).
    pub fn try_acquire() -> bool {
        let name = wide("Local\\ShredingerBox-single-instance");
        unsafe {
            let h = CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr());
            let err = GetLastError();
            if h.is_null() {
                // Нет доступа: мьютекс создала копия с правами администратора.
                return false;
            }
            if err == ERROR_ALREADY_EXISTS {
                CloseHandle(h);
                return false;
            }
            true
        }
    }

    pub fn focus_existing() {
        let title = wide("ShredingerBox");
        unsafe {
            let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
            if !hwnd.is_null() {
                ShowWindow(hwnd, 5); // SW_SHOW
                ShowWindow(hwnd, 9); // SW_RESTORE
                SetForegroundWindow(hwnd);
            }
        }
    }
}

/// Занять «место» единственной копии. `wait_ms` > 0 - подождать, пока старая копия
/// закроется (нужно при перезапуске с правами и при автозапуске).
pub fn acquire_single_instance(wait_ms: u64) -> bool {
    #[cfg(windows)]
    {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
        loop {
            if single::try_acquire() {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = wait_ms;
        true
    }
}

/// Показать окно уже запущенной копии.
pub fn focus_existing_instance() {
    #[cfg(windows)]
    single::focus_existing();
}

// ---------- автозапуск через планировщик задач ----------
//
// Задача с «наивысшими правами» решает сразу две вещи:
// 1) клиент стартует при входе в Windows уже с правами администратора (TUN без UAC);
// 2) обычный экземпляр может перезапуститься с правами через `schtasks /Run`
//    тоже без окна UAC.

const TASK_NAME: &str = "ShredingerBox";

#[cfg(windows)]
fn schtasks(args: &[&str]) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("schtasks")
        .args(args)
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn autostart_enabled() -> bool {
    #[cfg(windows)]
    {
        schtasks(&["/Query", "/TN", TASK_NAME])
    }
    #[cfg(not(windows))]
    {
        let _ = TASK_NAME;
        false
    }
}

#[cfg(windows)]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// XML задачи: без ограничений «только от сети» и «остановить через 3 дня»,
/// которые schtasks ставит по умолчанию.
#[cfg(windows)]
fn task_xml(exe: &std::path::Path) -> String {
    let user = format!(
        "{}\\{}",
        std::env::var("USERDOMAIN").unwrap_or_default(),
        std::env::var("USERNAME").unwrap_or_default()
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>ShredingerBox: запуск при входе в Windows</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId><Delay>PT10S</Delay></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>{exe}</Command><Arguments>--autostart</Arguments></Exec>
  </Actions>
</Task>"#,
        user = xml_escape(&user),
        exe = xml_escape(&exe.to_string_lossy()),
    )
}

/// Включить или выключить автозапуск. Без прав администратора Windows покажет UAC один раз.
pub fn set_autostart(enable: bool, data_dir: &std::path::Path) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let mut args: Vec<String> = vec![];
        if enable {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let xml_path = data_dir.join("autostart-task.xml");
            // schtasks ждёт XML в UTF-16 с BOM
            let mut bytes = vec![0xFF, 0xFE];
            for unit in task_xml(&exe).encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            std::fs::write(&xml_path, bytes).map_err(|e| e.to_string())?;
            args.extend(["/Create", "/F", "/TN", TASK_NAME, "/XML"].map(String::from));
            args.push(xml_path.to_string_lossy().to_string());
        } else {
            args.extend(["/Delete", "/F", "/TN", TASK_NAME].map(String::from));
        }

        if is_elevated() {
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            schtasks(&refs);
        } else {
            let params = args
                .iter()
                .map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() })
                .collect::<Vec<_>>()
                .join(" ");
            if !win::run_elevated(std::path::Path::new("schtasks.exe"), &params) {
                return Err(crate::i18n::tr("Права администратора не выданы", "Administrator rights were not granted").into());
            }
            // Задача создаётся в отдельном процессе - ждём, пока она появится или исчезнет.
            for _ in 0..40 {
                if autostart_enabled() == enable {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
        Ok(autostart_enabled())
    }
    #[cfg(not(windows))]
    {
        let _ = (enable, data_dir);
        Err(crate::i18n::tr("Автозапуск пока есть только в Windows", "Autostart is only available on Windows for now").into())
    }
}

/// Перезапуск с правами через задачу автозапуска - без окна UAC.
pub fn run_autostart_task() -> bool {
    #[cfg(windows)]
    {
        schtasks(&["/Run", "/TN", TASK_NAME])
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Открыть папку в проводнике или ссылку в браузере.
pub fn open_folder(path: impl AsRef<std::ffi::OsStr>) -> Result<(), String> {
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(path.as_ref())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
