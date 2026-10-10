use crate::{
    database::{self, Db},
    error::{AppError, Result},
    models::{id, now, Config},
    v2::{models::*, repository},
};
use base64::Engine;
use rusqlite::{params, Connection};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;
pub fn background_name(name: &str) -> Result<()> {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|v| v.to_str())
        .ok_or_else(|| AppError::new("image", "背景文件标识无效。"))?;
    crate::models::validate_id(stem)?;
    if path.file_name().and_then(|v| v.to_str()) != Some(name)
        || !matches!(
            path.extension().and_then(|v| v.to_str()),
            Some("png" | "jpg" | "webp")
        )
    {
        return Err(AppError::new("image", "背景文件类型或路径无效。"));
    }
    Ok(())
}
pub fn validate_image(bytes: &[u8]) -> Result<&'static str> {
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(AppError::new("image", "背景图片最大 8 MB。"));
    }
    let format = image::guess_format(bytes)
        .map_err(|_| AppError::new("image", "请选择 PNG、JPEG 或 WebP 图片。"))?;
    let extension = match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::WebP => "webp",
        _ => return Err(AppError::new("image", "不支持活动内容或其它图片类型。")),
    };
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| AppError::new("image", "图片损坏或超过 4096×4096 像素限制。"))?;
    Ok(extension)
}
pub fn make_bundle(conn: &Connection, directory: &Path) -> Result<Bundle> {
    let config = database::config(conn)?;
    let extension = repository::load(conn)?;
    let mut assets = vec![];
    if let Some(name) = &extension.theme.background_id {
        background_name(name)?;
        if let Ok(data) = std::fs::read(directory.join("backgrounds").join(name)) {
            validate_image(&data)?;
            assets.push(BackgroundAsset {
                id: name.clone(),
                data: base64::engine::general_purpose::STANDARD.encode(data),
            });
        }
    }
    Ok(Bundle {
        application: "StartFlow".into(),
        schema_version: 4,
        exported_at: now(),
        config,
        extension,
        assets,
        automation: Some(crate::automation::repository::load(conn)?),
        ai: Some(crate::ai::settings(conn)?),
        login: Some(crate::login::backup::load(conn)?),
    })
}
pub fn validate_bundle(b: &Bundle) -> Result<()> {
    if b.application != "StartFlow" || ![2, 3, 4].contains(&b.schema_version) || b.assets.len() > 1
    {
        return Err(AppError::new("format", "不支持此配置版本或应用标识。"));
    }
    repository::validate(&b.extension, &b.config)?;
    let login = b.login.clone().unwrap_or_default();
    login.validate()?;
    for w in &b.extension.workflows {
        login.workflow(w)?;
    }
    for t in &b.extension.templates {
        login.workflow(&t.workflow)?;
    }
    if let Some(a) = &b.automation {
        crate::rules::validator::validate(a, &b.config, &b.extension)?;
    }
    if let Some(a) = &b.ai {
        crate::ai::validate_settings(a)?;
    }
    for a in &b.assets {
        background_name(&a.id)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&a.data)
            .map_err(|_| AppError::new("image", "背景数据格式错误。"))?;
        let ext = validate_image(&bytes)?;
        if !a.id.ends_with(&format!(".{ext}")) {
            return Err(AppError::new("image", "背景内容和扩展名不一致。"));
        }
    }
    Ok(())
}
pub fn records(conn: &Connection) -> Result<Vec<BackupRecord>> {
    let mut s=conn.prepare("SELECT id,filename,backup_type,created_at,size,status FROM backup_records ORDER BY created_at DESC,rowid DESC")?;
    let v = s
        .query_map([], |r| {
            Ok(BackupRecord {
                id: r.get(0)?,
                filename: r.get(1)?,
                backup_type: r.get(2)?,
                created_at: r.get(3)?,
                size: r.get::<_, i64>(4)?.max(0) as u64,
                status: r.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}
pub fn create(db: &Db, kind: &str) -> Result<BackupRecord> {
    let g = db.lock()?;
    let b = make_bundle(&g.conn, Path::new(&db.directory))?;
    let key = id();
    let filename = format!("config-{key}.json");
    let folder = Path::new(&db.directory).join("backups");
    std::fs::create_dir_all(&folder).map_err(AppError::internal)?;
    let data = serde_json::to_vec_pretty(&b)?;
    let file = folder.join(&filename);
    std::fs::write(&file, &data)
        .map_err(|_| AppError::new("backup", "无法写入备份，原配置未修改。"))?;
    let record = BackupRecord {
        id: key,
        filename,
        backup_type: kind.into(),
        created_at: now(),
        size: data.len() as u64,
        status: "ready".into(),
    };
    if let Err(error) = g.conn.execute(
        "INSERT INTO backup_records VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            record.id,
            record.filename,
            record.backup_type,
            record.created_at,
            record.size as i64,
            record.status
        ],
    ) {
        let _ = std::fs::remove_file(file);
        return Err(error.into());
    }
    Ok(record)
}
pub fn managed_path(directory: &str, record: &BackupRecord) -> Result<PathBuf> {
    crate::models::validate_id(&record.id)?;
    if record.filename != format!("config-{}.json", record.id)
        && record.filename != format!("upgrade-{}.sqlite3", record.id)
    {
        return Err(AppError::new("backup", "备份文件标识无效。"));
    }
    let folder = Path::new(directory).join("backups");
    let file = folder.join(&record.filename);
    if file.exists() {
        let canonical = std::fs::canonicalize(&file).map_err(AppError::internal)?;
        let base = std::fs::canonicalize(folder).map_err(AppError::internal)?;
        if !canonical.starts_with(base) {
            return Err(AppError::new("backup", "备份路径超出数据目录。"));
        }
    }
    Ok(file)
}
pub fn read_json(path: &str) -> Result<Bundle> {
    crate::models::validate_path(path)?;
    let p = Path::new(path);
    if p.extension()
        .and_then(|v| v.to_str())
        .is_none_or(|x| !x.eq_ignore_ascii_case("json"))
    {
        return Err(AppError::new("format", "请选择 JSON 配置。"));
    }
    if std::fs::metadata(p).map_err(AppError::internal)?.len() > 40 * 1024 * 1024 {
        return Err(AppError::new("format", "配置文件最多 40 MB。"));
    }
    let text = std::fs::read_to_string(p)
        .map_err(|_| AppError::new("format", "配置文件读取失败，请检查 UTF-8 编码。"))?;
    let text = text.trim_start_matches('\u{feff}');
    let value: serde_json::Value = serde_json::from_str(text)?;
    let b = if value.get("application").is_some() {
        serde_json::from_value(value)?
    } else {
        Bundle {
            application: "StartFlow".into(),
            schema_version: 2,
            exported_at: now(),
            config: serde_json::from_value::<Config>(value)?,
            extension: Extension::default(),
            assets: vec![],
            automation: None,
            ai: None,
            login: None,
        }
    };
    validate_bundle(&b)?;
    Ok(b)
}
pub fn read_record(db: &Db, key: &str) -> Result<Bundle> {
    let record = records(&db.lock()?.conn)?
        .into_iter()
        .find(|r| r.id == key)
        .ok_or_else(|| AppError::new("backup", "备份记录不存在。"))?;
    let file = managed_path(&db.directory, &record)?;
    if record.backup_type == "upgrade" {
        let c = Connection::open_with_flags(&file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let bundle = Bundle {
            application: "StartFlow".into(),
            schema_version: 4,
            exported_at: record.created_at,
            config: database::config(&c)?,
            extension: if c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='workflows'",
                [],
                |r| r.get::<_, i64>(0),
            )? > 0
            {
                repository::load(&c)?
            } else {
                Extension::default()
            },
            assets: vec![],
            automation: None,
            ai: None,
            login: Some(crate::login::backup::load(&c)?),
        };
        validate_bundle(&bundle)?;
        Ok(bundle)
    } else {
        read_json(&file.to_string_lossy())
    }
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        loop {
            let handle = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || tick(&handle)).await;
            if let Ok(Err(e)) = result {
                crate::engine::report_error(&app, &e);
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
fn tick(app: &tauri::AppHandle) -> Result<()> {
    use chrono::Datelike;
    let db = app.state::<Db>();
    let (theme, history) = {
        let g = db.lock()?;
        (repository::load(&g.conn)?.theme, records(&g.conn)?)
    };
    if theme.backup_frequency == "off" {
        return Ok(());
    }
    let today = chrono::Local::now().date_naive();
    let already = history
        .iter()
        .filter(|r| r.backup_type == "automatic" && r.status == "ready")
        .any(|r| {
            chrono::DateTime::parse_from_rfc3339(&r.created_at).is_ok_and(|t| {
                let date = t.with_timezone(&chrono::Local).date_naive();
                if theme.backup_frequency == "weekly" {
                    date.iso_week() == today.iso_week()
                } else {
                    date == today
                }
            })
        });
    if !already {
        create(&db, "automatic")?;
        crate::engine::changed(app);
    }
    let history = records(&db.lock()?.conn)?;
    let old: Vec<_> = history
        .into_iter()
        .filter(|r| r.backup_type == "automatic")
        .skip(theme.backup_retention as usize)
        .collect();
    for record in old {
        let file = managed_path(&db.directory, &record)?;
        if file.exists() {
            std::fs::remove_file(file).map_err(AppError::internal)?;
        }
        db.lock()?
            .conn
            .execute("DELETE FROM backup_records WHERE id=?1", [record.id])?;
    }
    Ok(())
}
pub fn merge(current: &Bundle, incoming: &Bundle) -> Result<Bundle> {
    let mut result = current.clone();
    let mut imported = incoming.clone();
    crate::login::backup::remap(&mut imported)?;
    let mut map = std::collections::HashMap::new();
    // Always allocate new imported IDs, preserving both conflicting and non-conflicting entities.
    for key in imported
        .config
        .scenes
        .iter()
        .map(|s| &s.id)
        .chain(imported.config.tasks.iter().map(|s| &s.id))
        .chain(imported.config.scene_tasks.iter().map(|s| &s.id))
        .chain(imported.config.schedules.iter().map(|s| &s.id))
        .chain(imported.extension.workflows.iter().map(|s| &s.id))
        .chain(imported.extension.layouts.iter().map(|s| &s.id))
        .chain(imported.extension.shortcuts.iter().map(|s| &s.id))
        .chain(imported.extension.templates.iter().map(|s| &s.id))
    {
        map.entry(key.clone()).or_insert_with(id);
    }
    for w in &imported.extension.workflows {
        for n in &w.nodes {
            map.entry(n.id.clone()).or_insert_with(id);
        }
        for a in &w.edges {
            map.entry(a.id.clone()).or_insert_with(id);
        }
    }
    for l in &imported.extension.layouts {
        for i in &l.items {
            map.entry(i.id.clone()).or_insert_with(id);
        }
    }
    if let Some(a) = &imported.automation {
        for key in a
            .rules
            .iter()
            .map(|r| &r.id)
            .chain(a.modes.iter().map(|m| &m.id))
            .chain(a.networks.iter().map(|n| &n.id))
        {
            map.entry(key.clone()).or_insert_with(id);
        }
    }
    // Re-map UUID string values structurally; arbitrary user text and paths are never rewritten.
    fn rewrite(
        value: &mut serde_json::Value,
        map: &std::collections::HashMap<String, String>,
        field: Option<&str>,
    ) {
        match value {
            serde_json::Value::Object(o) => {
                for (k, v) in o {
                    rewrite(v, map, Some(k));
                }
            }
            serde_json::Value::Array(a) => {
                for v in a {
                    rewrite(v, map, field);
                }
            }
            serde_json::Value::String(s)
                if matches!(
                    field,
                    Some(
                        "id" | "scene_id"
                            | "task_id"
                            | "workflow_id"
                            | "layout_id"
                            | "fallback_layout_id"
                            | "target_id"
                            | "source"
                            | "target"
                            | "default_scene_id"
                            | "mode_id"
                            | "network_id"
                    )
                ) =>
            {
                if let Some(new) = map.get(s) {
                    *s = new.clone();
                }
            }
            _ => {}
        }
    }
    let mut value = serde_json::to_value(&imported)?;
    rewrite(&mut value, &map, None);
    imported = serde_json::from_value(value)?;
    // Personal template nodes live outside workflow tables but still receive fresh stable IDs.
    for t in &mut imported.extension.templates {
        let scene = t.workflow.scene_id.clone();
        t.workflow = repository::clone_workflow(&t.workflow, &scene);
    }
    result.config.scenes.extend(imported.config.scenes);
    result.config.tasks.extend(imported.config.tasks);
    result
        .config
        .scene_tasks
        .extend(imported.config.scene_tasks);
    result.config.schedules.extend(imported.config.schedules);
    result
        .extension
        .workflows
        .extend(imported.extension.workflows);
    result
        .extension
        .bindings
        .extend(imported.extension.bindings);
    result.extension.layouts.extend(imported.extension.layouts);
    result
        .extension
        .templates
        .extend(imported.extension.templates);
    // Imported hotkeys stay disabled and conflicts with existing accelerators are omitted.
    for mut s in imported.extension.shortcuts {
        if !result.extension.shortcuts.iter().any(|x| {
            crate::shortcuts::parse(&x.accelerator).ok()
                == crate::shortcuts::parse(&s.accelerator).ok()
        }) {
            s.enabled = false;
            result.extension.shortcuts.push(s);
        }
    }
    result.config.settings.paused = true;
    result.schema_version = 4;
    if let Some(login) = imported.login {
        let existing = result.login.get_or_insert_with(Default::default);
        existing.accounts.extend(login.accounts);
        existing.web.extend(login.web);
        existing.desktop.extend(login.desktop);
    }
    if let Some(mut a) = imported.automation {
        for r in &mut a.rules {
            r.id = map.get(&r.id).cloned().unwrap_or_else(|| r.id.clone());
            r.enabled = false;
            r.policy = "confirm".into();
        }
        for m in &mut a.modes {
            m.strategy = "suggest".into();
        }
        let target = result.automation.get_or_insert_with(Default::default);
        target.rules.extend(a.rules);
        target.modes.extend(a.modes);
        target.networks.extend(a.networks);
    }
    validate_bundle(&result)?;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Scene, SceneTask, Task};
    #[test]
    fn merge_remaps_references_without_rewriting_arbitrary_text() {
        let scene = id();
        let task = id();
        let stamp = now();
        let mut config = Config::default();
        config.scenes.push(Scene {
            id: scene.clone(),
            name: scene.clone(),
            description: task.clone(),
            icon: "briefcase".into(),
            color: "#3B82F6".into(),
            enabled: true,
            sort_order: 0,
            created_at: stamp.clone(),
            updated_at: stamp.clone(),
        });
        config.tasks.push(Task {
            id: task.clone(),
            name: "网页".into(),
            kind: "web".into(),
            url: "https://www.bing.com".into(),
            executable_path: "".into(),
            arguments: vec![],
            working_directory: "".into(),
            browser_mode: "default".into(),
            browser_path: "".into(),
            delay_ms: 0,
            wait_for_network: false,
            skip_if_running: false,
            enabled: true,
            created_at: stamp.clone(),
            updated_at: stamp,
        });
        config.scene_tasks.push(SceneTask {
            id: id(),
            scene_id: scene.clone(),
            task_id: task.clone(),
            sort_order: 0,
        });
        let mut extension = Extension::default();
        let w = crate::workflow::executor::convert(&scene, &config).unwrap();
        extension.bindings.push(Binding {
            scene_id: scene.clone(),
            workflow_id: w.id.clone(),
        });
        extension.workflows.push(w);
        let bundle = Bundle {
            application: "StartFlow".into(),
            schema_version: 2,
            exported_at: now(),
            config,
            extension,
            assets: vec![],
            automation: None,
            ai: None,
            login: None,
        };
        let merged = merge(&bundle, &bundle).unwrap();
        assert_eq!(merged.config.scenes.len(), 2);
        assert_ne!(merged.config.scenes[1].id, scene);
        assert_eq!(merged.config.scenes[1].name, scene);
        assert_eq!(merged.config.scenes[1].description, task);
        assert_eq!(
            merged.config.scene_tasks[1].scene_id,
            merged.config.scenes[1].id
        );
        assert_eq!(
            merged.extension.workflows[1].scene_id,
            merged.config.scenes[1].id
        );
        assert_eq!(
            merged.extension.bindings[1].workflow_id,
            merged.extension.workflows[1].id
        );
        validate_bundle(&merged).unwrap();
    }
    #[test]
    fn active_content_and_managed_path_escape_are_rejected() {
        assert!(validate_image(b"<svg onload='execute()'></svg>").is_err());
        assert!(background_name("../escape.png").is_err());
        assert!(background_name("file.svg").is_err());
    }
}
