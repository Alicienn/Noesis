#!/usr/bin/env bash
# Noesis — installation de l'environnement de vérification formelle (Lean 4 + Mathlib + Comparator).
# À exécuter DANS WSL (Ubuntu) :  bash scripts/lean/setup-wsl.sh
# Idempotent : chaque étape est sautée si elle est déjà faite. Aucun sudo requis.
#
# Résultat :
#   ~/.elan/bin/{lean,lake}           toolchain Lean
#   ~/noesis-lean/                    espace Lake partagé par tous les projets Noesis (Mathlib précompilée)
#   ~/.local/bin/{landrun,lean4export,comparator}
set -euo pipefail

LEAN_VERSION="${NOESIS_LEAN_VERSION:-v4.34.0}"          # Mathlib, lean4export et comparator sont alignés sur cette version
COMPARATOR_REV="${NOESIS_COMPARATOR_REV:-d03acab154d2}"  # dernier commit de comparator sur la toolchain v4.34.0
WORKSPACE="${NOESIS_LEAN_WORKSPACE:-$HOME/noesis-lean}"
TOOLS="$HOME/.local/share/noesis-lean-tools"
BIN="$HOME/.local/bin"

export PATH="$HOME/.elan/bin:$HOME/.local/go/bin:$BIN:$PATH"
mkdir -p "$BIN" "$TOOLS"

step() { echo; echo "==> $*"; }

# 1. elan + toolchain -------------------------------------------------------
if ! command -v elan >/dev/null 2>&1; then
  step "Installation d'elan"
  curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --default-toolchain none --no-modify-path
fi
step "Toolchain leanprover/lean4:$LEAN_VERSION"
elan toolchain install "leanprover/lean4:$LEAN_VERSION"
elan default "leanprover/lean4:$LEAN_VERSION"

# 2. Espace Lake partagé avec Mathlib -----------------------------------------
step "Espace Lean partagé : $WORKSPACE"
mkdir -p "$WORKSPACE/Checks"
cd "$WORKSPACE"
echo "leanprover/lean4:$LEAN_VERSION" > lean-toolchain
cat > lakefile.toml <<EOF
name = "NoesisLean"
defaultTargets = []

[leanOptions]
autoImplicit = false

[[require]]
name = "mathlib"
git = "https://github.com/leanprover-community/mathlib4"
rev = "$LEAN_VERSION"

# Chaque vérification vit dans Checks/<projet>/<vérification>/{Challenge,Solution}.lean
[[lean_lib]]
name = "Checks"
globs = ["Checks.+"]

# Brouillons des agents (lean_run)
[[lean_lib]]
name = "Scratch"
globs = ["Scratch.+"]
EOF
mkdir -p Scratch
[ -f .gitignore ] || printf '.lake/\n' > .gitignore
if [ ! -d .lake/packages/mathlib ]; then
  step "Téléchargement de Mathlib (lake update)"
  lake update
fi
step "Cache Mathlib précompilé (lake exe cache get)"
lake exe cache get

step "Test : import Mathlib"
cat > Scratch/SetupTest.lean <<'EOF'
import Mathlib
example : (2 : ℝ) + 2 = 4 := by norm_num
EOF
lake env lean Scratch/SetupTest.lean
rm -f Scratch/SetupTest.lean

# 3. landrun (bac à sable Landlock, compilé depuis main) ------------------------
if ! command -v landrun >/dev/null 2>&1; then
  if ! command -v go >/dev/null 2>&1; then
    step "Installation de Go (pour compiler landrun)"
    GOVER="$(curl -sSfL 'https://go.dev/VERSION?m=text' | head -1)"
    curl -sSfL "https://go.dev/dl/${GOVER}.linux-amd64.tar.gz" -o "$TOOLS/go.tgz"
    rm -rf "$HOME/.local/go" && tar -C "$HOME/.local" -xzf "$TOOLS/go.tgz" && rm -f "$TOOLS/go.tgz"
  fi
  step "Compilation de landrun"
  rm -rf "$TOOLS/landrun"
  git clone --depth 1 https://github.com/Zouuup/landrun "$TOOLS/landrun"
  (cd "$TOOLS/landrun" && go build -o "$BIN/landrun" ./cmd/landrun)
fi

# 4. lean4export (même version de Lean que l'espace partagé) ------------------
if [ ! -x "$BIN/lean4export" ]; then
  step "Compilation de lean4export $LEAN_VERSION"
  rm -rf "$TOOLS/lean4export"
  git clone --depth 1 --branch "$LEAN_VERSION" https://github.com/leanprover/lean4export "$TOOLS/lean4export"
  (cd "$TOOLS/lean4export" && echo "leanprover/lean4:$LEAN_VERSION" > lean-toolchain && lake build)
  ln -sf "$TOOLS/lean4export/.lake/build/bin/lean4export" "$BIN/lean4export"
fi

# 5. comparator ---------------------------------------------------------------
if [ ! -x "$BIN/comparator" ]; then
  step "Compilation de comparator ($COMPARATOR_REV)"
  rm -rf "$TOOLS/comparator"
  git clone https://github.com/leanprover/comparator "$TOOLS/comparator"
  (cd "$TOOLS/comparator" && git checkout -q "$COMPARATOR_REV" && lake build comparator)
  ln -sf "$TOOLS/comparator/.lake/build/bin/comparator" "$BIN/comparator"
fi

# 6. Test de bout en bout de comparator ----------------------------------------
step "Test de comparator (preuve correcte puis preuve truquée)"
T="$WORKSPACE/Checks/Selftest"
rm -rf "$T" && mkdir -p "$T"
cat > "$T/Challenge.lean" <<'EOF'
import Mathlib
theorem noesisSelftest (a b : ℕ) : a + b = b + a := by sorry
EOF
cat > "$T/Solution.lean" <<'EOF'
import Mathlib
theorem noesisSelftest (a b : ℕ) : a + b = b + a := Nat.add_comm a b
EOF
cat > "$T/config.json" <<'EOF'
{ "challenge_module": "Checks.Selftest.Challenge", "solution_module": "Checks.Selftest.Solution",
  "theorem_names": ["noesisSelftest"], "permitted_axioms": ["propext", "Quot.sound", "Classical.choice"] }
EOF
(cd "$WORKSPACE" && lake env comparator "$T/config.json")
cat > "$T/Solution.lean" <<'EOF'
import Mathlib
axiom cheat : False
theorem noesisSelftest (a b : ℕ) : a + b = b + a := cheat.elim
EOF
if (cd "$WORKSPACE" && lake env comparator "$T/config.json") >/dev/null 2>&1; then
  echo "ERREUR : comparator a accepté une preuve utilisant un axiome interdit." >&2
  exit 1
fi
rm -rf "$T" "$WORKSPACE/.lake/build/lib/lean/Checks/Selftest" "$WORKSPACE/.lake/build/ir/Checks/Selftest"

step "Terminé"
du -sh "$HOME/.elan" "$WORKSPACE" "$TOOLS" 2>/dev/null || true
echo "NOESIS_LEAN_READY"
