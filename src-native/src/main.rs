mod backend;
mod capture_reader;
mod capture_timing;
mod device_identity;

fn main() {
    backend::sidecar_entry();
}
