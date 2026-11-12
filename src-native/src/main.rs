mod backend;
mod capture_reader;
mod capture_timing;
mod device_identity;
mod instance_lock;

fn main() {
    backend::sidecar_entry();
}
