use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use anyhow::{Result, ensure};
use serde_json::Value;

use super::Manifest;

pub(super) fn append(file: &mut File, event: &Value) -> Result<()> {
    let data = serde_json::to_vec(event)
        .map_err(|_| anyhow::anyhow!("could not encode manifest event"))?;
    file.write_all(b"\n")
        .and_then(|_| file.write_all(&data))
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|_| anyhow::anyhow!("could not durably append manifest event"))
}

pub(super) fn open_manifest(path: &PathBuf) -> Result<(Manifest, File)> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|_| anyhow::anyhow!("could not inspect manifest"))?;
    ensure!(
        before.is_file() && before.permissions().mode() & 0o777 == 0o600,
        "existing manifest must be a regular non-symlink file with permissions 0600"
    );
    let file = OpenOptions::new()
        .read(true)
        .append(true)
        .open(path)
        .map_err(|_| anyhow::anyhow!("could not open existing manifest"))?;
    let after = file
        .metadata()
        .map_err(|_| anyhow::anyhow!("could not inspect opened manifest"))?;
    ensure!(
        before.dev() == after.dev() && before.ino() == after.ino(),
        "manifest changed while opening"
    );
    let mut header = String::new();
    BufReader::new(&file)
        .read_line(&mut header)
        .map_err(|_| anyhow::anyhow!("could not read manifest"))?;
    let manifest = serde_json::from_str::<Manifest>(&header)
        .map_err(|_| anyhow::anyhow!("invalid manifest header"))?;
    ensure!(manifest.format == 1, "unsupported manifest format");
    ensure!(
        manifest.rows.iter().all(|p| p.row.snapshot.is_object()),
        "invalid manifest row snapshot"
    );
    Ok((manifest, file))
}

pub(super) fn create_manifest(path: &PathBuf, manifest: &Manifest) -> Result<File> {
    let mut file = OpenOptions::new()
        .append(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| {
            anyhow::anyhow!(
                "could not exclusively create manifest; existing files are never overwritten"
            )
        })?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|_| anyhow::anyhow!("could not secure manifest permissions"))?;
    let data =
        serde_json::to_vec(manifest).map_err(|_| anyhow::anyhow!("could not encode manifest"))?;
    file.write_all(&data)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|_| anyhow::anyhow!("could not durably save manifest; no objects changed"))?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| {
            anyhow::anyhow!("could not durably save manifest directory; no objects changed")
        })?;
    Ok(file)
}
