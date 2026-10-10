use std::{collections::HashSet, fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::backend::AvailablePort;

pub const REVIEW_PREFIX: &str = "Device identity needs review:";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceIdentity {
    pub vendor_id: u16,
    pub product_id: u16,
    pub serial_number: Option<String>,
    pub stable_path: Option<String>,
}

pub fn same_port(first: &str, second: &str) -> bool {
    first == second
        || match (fs::canonicalize(first), fs::canonicalize(second)) {
            (Ok(first), Ok(second)) => first == second,
            _ => false,
        }
}

pub fn stable_device_path(port: &str) -> Option<String> {
    // Retain by-id to distinguish interfaces on an identified device. Model-only
    // aliases can collide, so an alias alone never authorizes automatic reconnect.
    let mut paths: Vec<_> = fs::read_dir("/dev/serial/by-id")
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| same_port(&path.to_string_lossy(), port))
        .collect();
    paths.sort();
    paths
        .first()
        .map(|path| path.to_string_lossy().into_owned())
}

pub fn validate_identity(identity: &DeviceIdentity) -> Result<(), String> {
    if identity
        .serial_number
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 256)
        || identity.stable_path.as_ref().is_some_and(|value| {
            value.len() > 256
                || Path::new(value).parent() != Some(Path::new("/dev/serial/by-id"))
                || value.contains("/../")
                || value.contains("/./")
        })
    {
        return Err("Invalid serial device identity.".into());
    }
    Ok(())
}

pub fn resolve_device_port(
    original: &str,
    identity: &DeviceIdentity,
    automatic: bool,
    ports: &[AvailablePort],
) -> Result<String, String> {
    validate_identity(identity)?;
    let mut seen = HashSet::new();
    let matches: Vec<_> = ports
        .iter()
        .filter(|port| {
            let Some(candidate) = &port.device_identity else {
                return false;
            };
            candidate.vendor_id == identity.vendor_id
                && candidate.product_id == identity.product_id
                && identity.serial_number.as_ref().map_or(true, |serial| {
                    candidate.serial_number.as_ref() == Some(serial)
                })
                && seen.insert(
                    fs::canonicalize(&port.path).unwrap_or_else(|_| port.path.clone().into()),
                )
        })
        .collect();

    // udev can create a model-only by-id alias without a USB serial number.
    // Such an alias can move to an identical adapter; only an explicit manual
    // retry at the original port is allowed for these devices.
    if identity.serial_number.is_none() {
        if automatic {
            return Err(format!("{REVIEW_PREFIX} This USB adapter has no unique device ID. Choose its port in connection setup, or reconnect manually after checking the device."));
        }
        return matches.iter().find(|port| same_port(original, &port.path)).map(|port| port.path.clone())
            .ok_or_else(|| format!("{REVIEW_PREFIX} The original port is absent or belongs to a different USB device. Choose the intended port in connection setup."));
    }

    // A stable alias distinguishes interfaces on a device with a serial number.
    if let Some(path) = &identity.stable_path {
        let alias_matches: Vec<_> = matches
            .iter()
            .filter(|port| {
                port.device_identity
                    .as_ref()
                    .and_then(|candidate| candidate.stable_path.as_ref())
                    == Some(path)
                    || same_port(path, &port.path)
            })
            .collect();
        return match alias_matches.as_slice() {
            [port] => Ok(port.path.clone()),
            // An absent alias must not bind another interface/identical adapter.
            [] => Err(format!("Waiting for the original device ({path}) to return.")),
            _ => Err(format!("{REVIEW_PREFIX} Multiple ports share this USB alias. Choose the intended port in connection setup.")),
        };
    }
    match matches.as_slice() {
            [port] => Ok(port.path.clone()),
            [] => Err("Waiting for the original USB device to return.".into()),
            _ => Err(format!("{REVIEW_PREFIX} Multiple ports share this USB identity. Choose the intended port in connection setup.")),
    }
}

/// A setup review explicitly chose this port. Recheck its entire retained USB
/// identity at connection time; never substitute a different matching port.
pub fn resolve_reviewed_port(
    original: &str,
    identity: &DeviceIdentity,
    ports: &[AvailablePort],
) -> Result<String, String> {
    validate_identity(identity)?;
    ports.iter().find(|port| {
        same_port(original, &port.path) && port.device_identity.as_ref().is_some_and(|candidate| {
            candidate.vendor_id == identity.vendor_id && candidate.product_id == identity.product_id
                && identity.serial_number.as_ref().map_or(true, |serial| candidate.serial_number.as_ref() == Some(serial))
                && identity.stable_path.as_ref().map_or(true, |path| candidate.stable_path.as_ref() == Some(path) || same_port(path, &port.path))
        })
    }).map(|port| port.path.clone()).ok_or_else(|| format!("{REVIEW_PREFIX} The selected port changed or its USB identity no longer matches. Rescan the setup before restoring."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(serial: Option<&str>, stable: Option<&str>) -> DeviceIdentity {
        DeviceIdentity {
            vendor_id: 0x10c4,
            product_id: 0xea60,
            serial_number: serial.map(str::to_owned),
            stable_path: stable.map(str::to_owned),
        }
    }

    fn port(path: &str, device: DeviceIdentity) -> AvailablePort {
        AvailablePort {
            path: path.into(),
            label: "USB serial".into(),
            manufacturer: None,
            product: None,
            serial_number: device.serial_number.clone(),
            transport: "usb".into(),
            device_identity: Some(device),
        }
    }

    #[test]
    fn follows_serial_to_new_port_and_ignores_reused_old_port() {
        let expected = identity(Some("board-A"), None);
        let ports = [
            port("/dev/ttyUSB0", identity(Some("board-B"), None)),
            port("/dev/ttyUSB1", expected.clone()),
        ];
        assert_eq!(
            resolve_device_port("/dev/ttyUSB0", &expected, true, &ports).unwrap(),
            "/dev/ttyUSB1"
        );
        assert!(
            resolve_device_port("/dev/ttyUSB0", &expected, true, &ports[..1])
                .unwrap_err()
                .starts_with("Waiting")
        );
    }

    #[test]
    fn refuses_ambiguous_ids_and_unidentified_automatic_reconnects() {
        let expected = identity(Some("duplicate"), None);
        let ports = [
            port("/dev/ttyUSB0", expected.clone()),
            port("/dev/ttyUSB1", expected.clone()),
        ];
        assert!(resolve_device_port("/dev/ttyUSB0", &expected, true, &ports)
            .unwrap_err()
            .starts_with(REVIEW_PREFIX));
        let unknown = identity(None, None);
        let ports = [port("/dev/ttyUSB0", unknown.clone())];
        assert!(resolve_device_port("/dev/ttyUSB0", &unknown, true, &ports)
            .unwrap_err()
            .starts_with(REVIEW_PREFIX));
        assert_eq!(
            resolve_device_port("/dev/ttyUSB0", &unknown, false, &ports).unwrap(),
            "/dev/ttyUSB0"
        );
    }

    #[test]
    fn serialless_alias_never_authorizes_automatic_device_substitution() {
        let expected = identity(None, Some("/dev/serial/by-id/usb-model-if00"));
        // The model-only alias now belongs to an identical replacement adapter.
        let ports = [port("/dev/ttyUSB1", expected.clone())];
        assert!(resolve_device_port("/dev/ttyUSB0", &expected, true, &ports)
            .unwrap_err()
            .starts_with(REVIEW_PREFIX));
        assert!(
            resolve_device_port("/dev/ttyUSB0", &expected, false, &ports)
                .unwrap_err()
                .starts_with(REVIEW_PREFIX)
        );
        // An explicit review can still select the replacement deliberately.
        assert_eq!(
            resolve_reviewed_port("/dev/ttyUSB1", &expected, &ports).unwrap(),
            "/dev/ttyUSB1"
        );
        let original = [port("/dev/ttyUSB0", expected.clone())];
        assert_eq!(
            resolve_device_port("/dev/ttyUSB0", &expected, false, &original).unwrap(),
            "/dev/ttyUSB0"
        );
    }

    #[test]
    fn colliding_aliases_require_review_instead_of_selecting_the_first_port() {
        let expected = identity(Some("duplicate"), Some("/dev/serial/by-id/board-if00"));
        let ports = [
            port("/dev/ttyUSB0", expected.clone()),
            port("/dev/ttyUSB1", expected.clone()),
        ];
        assert!(resolve_device_port("/dev/ttyUSB0", &expected, true, &ports)
            .unwrap_err()
            .starts_with(REVIEW_PREFIX));
    }

    #[test]
    fn alias_distinguishes_interfaces_and_never_falls_back_to_another() {
        let expected = identity(Some("multiport"), Some("/dev/serial/by-id/board-if00"));
        let ports = [
            port(
                "/dev/ttyUSB1",
                identity(Some("multiport"), Some("/dev/serial/by-id/board-if01")),
            ),
            port("/dev/ttyUSB2", expected.clone()),
        ];
        assert_eq!(
            resolve_device_port("/dev/ttyUSB0", &expected, true, &ports).unwrap(),
            "/dev/ttyUSB2"
        );
        assert!(resolve_device_port("/dev/ttyUSB0", &expected, true, &ports[..1]).is_err());
    }

    #[test]
    fn rejects_arbitrary_alias_paths_and_wrong_usb_models() {
        assert!(validate_identity(&identity(None, Some("/etc/passwd"))).is_err());
        assert!(validate_identity(&identity(None, Some("/dev/serial/by-id/../other"))).is_err());
        let expected = identity(Some("board"), None);
        let mut wrong = expected.clone();
        wrong.product_id += 1;
        assert!(resolve_device_port(
            "/dev/ttyUSB0",
            &expected,
            true,
            &[port("/dev/ttyUSB0", wrong)]
        )
        .is_err());
    }
    #[test]
    fn explicit_review_checks_exact_port_and_identity_without_substitution() {
        let expected = identity(Some("duplicate"), None);
        let ports = [
            port("/dev/ttyUSB0", expected.clone()),
            port("/dev/ttyUSB1", expected.clone()),
        ];
        assert_eq!(
            resolve_reviewed_port("/dev/ttyUSB1", &expected, &ports).unwrap(),
            "/dev/ttyUSB1"
        );
        assert!(resolve_reviewed_port("/dev/ttyUSB2", &expected, &ports).is_err());
        let replaced = [
            port("/dev/ttyUSB1", identity(Some("different"), None)),
            port("/dev/ttyUSB0", expected.clone()),
        ];
        assert!(resolve_reviewed_port("/dev/ttyUSB1", &expected, &replaced).is_err());
        let unknown = identity(None, None);
        assert_eq!(
            resolve_reviewed_port("/dev/ttyUSB1", &unknown, &ports).unwrap(),
            "/dev/ttyUSB1"
        );
    }
}
