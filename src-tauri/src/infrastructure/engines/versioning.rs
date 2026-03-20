use std::cmp::Ordering;

pub(crate) fn normalize_version(raw: &str) -> String {
    raw.trim().trim_start_matches('v').to_string()
}

pub(crate) fn is_newer_version(latest: &str, current: &str) -> bool {
    compare_versions(latest, current) == Ordering::Greater
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let left_parts = parse_version_parts(left);
    let right_parts = parse_version_parts(right);
    let max_len = left_parts.len().max(right_parts.len());
    for idx in 0..max_len {
        let l = *left_parts.get(idx).unwrap_or(&0);
        let r = *right_parts.get(idx).unwrap_or(&0);
        match l.cmp(&r) {
            Ordering::Equal => continue,
            non_eq => return non_eq,
        }
    }
    Ordering::Equal
}

fn parse_version_parts(raw: &str) -> Vec<u32> {
    let mut parts = Vec::<u32>::new();
    let mut current = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
        } else if !current.is_empty() {
            if let Ok(num) = current.parse::<u32>() {
                parts.push(num);
            }
            current.clear();
        }
    }
    if !current.is_empty() {
        if let Ok(num) = current.parse::<u32>() {
            parts.push(num);
        }
    }
    parts
}
