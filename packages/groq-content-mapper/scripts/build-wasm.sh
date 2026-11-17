#!/usr/bin/env bash
# Builds rust/ to wasm/, which is committed so that installing the package needs no Rust. The
# build is reproducible: CI rebuilds and compares. Needs rustup, which installs the toolchain
# rust/rust-toolchain.toml pins, and wasm-bindgen-cli at the version rust/Cargo.toml pins:
# `cargo install wasm-bindgen-cli --locked --version 0.2.130`.
set -euo pipefail

package="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate="$package/rust"
out="$package/wasm"

# Panic messages carry source paths; without this they would name the building machine.
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=.cargo --remap-path-prefix=$crate=."

# From the crate, so that rustup picks the toolchain rust-toolchain.toml pins.
cd "$crate"
cargo build --release --target wasm32-unknown-unknown
# The name section carries crate hashes that depend on the crate's absolute path.
wasm-bindgen --target web --remove-name-section --remove-producers-section \
  --out-dir "$out" --out-name groq \
  "$crate/target/wasm32-unknown-unknown/release/groq_content_mapper_wasm.wasm"
