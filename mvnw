#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MVN_VERSION="3.9.9"
MVN_DIR="${PROJECT_DIR}/.mvn/apache-maven-${MVN_VERSION}"
MVN_BIN="${MVN_DIR}/bin/mvn"

if [[ ! -x "${MVN_BIN}" ]]; then
  echo "Downloading Maven ${MVN_VERSION} ..."
  mkdir -p "${PROJECT_DIR}/.mvn/cache"
  ARCHIVE="${PROJECT_DIR}/.mvn/cache/apache-maven-${MVN_VERSION}-bin.tar.gz"
  if [[ ! -f "${ARCHIVE}" ]]; then
    curl -L --fail -o "${ARCHIVE}" "https://archive.apache.org/dist/maven/maven-3/${MVN_VERSION}/binaries/apache-maven-${MVN_VERSION}-bin.tar.gz"
  fi

  rm -rf "${MVN_DIR}"
  mkdir -p "${MVN_DIR}"
  tar -xzf "${ARCHIVE}" -C "${PROJECT_DIR}/.mvn"
  # tar extracts into .mvn/apache-maven-<version>/
  if [[ -d "${PROJECT_DIR}/.mvn/apache-maven-${MVN_VERSION}" ]]; then
    MVN_DIR="${PROJECT_DIR}/.mvn/apache-maven-${MVN_VERSION}"
    MVN_BIN="${MVN_DIR}/bin/mvn"
  fi
fi

exec "${MVN_BIN}" "$@"

