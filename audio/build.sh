#!/bin/sh
# Build the capture helper (Swift, Command Line Tools) and the analyzer's Python environment.
set -e
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O -o bin/s1tap tap/s1tap.swift -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker tap/Info.plist
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
echo "Built audio/bin/s1tap and audio/.venv"
