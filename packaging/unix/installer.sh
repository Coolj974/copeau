#!/bin/sh
set -eu

case "$(uname -s)" in
  Darwin) dest="$HOME/Applications/Copeau" ;;
  Linux) dest="$HOME/.local/opt/Copeau" ;;
  *) echo "Système non pris en charge." >&2; exit 1 ;;
esac
cd -- "$(dirname -- "$0")"
mkdir -p "$dest"
install -m 755 copeau-rust Lancer-Copeau.command "$dest/"
install -m 644 LISEZ-MOI.txt "$dest/"
printf 'Copeau installé. Lancez : "%s/Lancer-Copeau.command"\n' "$dest"
