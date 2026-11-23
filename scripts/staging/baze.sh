#!/usr/bin/env bash
# Staging baze: koraci 3, 4 i 6 iz docs/STAGING.md kao jedna skripta (bash: Git Bash ili WSL).
# Pokreće Daniel u korijenu repoa, na grani migracija/kopija-ductus-backend, nakon `pnpm install`.
# Adrese baza i lozinke unosiš skriveno; ništa se ne zapisuje na disk ni u povijest ljuske.
# Smije se pokrenuti ponovno: uloga koja već postoji ostaje, lozinka se postavlja iznova,
# migracije i seed preskaču ono što je već napravljeno.
#
#   bash scripts/staging/baze.sh 3     glavna baza: provjera vlasnika, ductus_migrator, migracije
#   bash scripts/staging/baze.sh 4     prijave ductura_stg_app i ductura_stg_auth, baza zapisa ductus_logs
#   bash scripts/staging/baze.sh 6     izmišljeni podaci; treba issuer lažnog OIDC servisa (STG-OIDC)
#   bash scripts/staging/baze.sh sve   koraci 3 i 4
#
# Ako se ova skripta i docs/STAGING.md razlikuju, vrijedi docs/STAGING.md; uskladi ih u istom PR-u.
set -euo pipefail
# Git Bash bi vrijednost koja izgleda kao putanja (npr. lozinka koja počinje s /) pretvorio u Windows
# putanju prije nego što stigne do psql.exe, pa bi uloga dobila drugu lozinku. Ovo to isključuje za lozinke.
export MSYS2_ENV_CONV_EXCL='STG_APP_PASSWORD;STG_AUTH_PASSWORD;STG_LOGS_PASSWORD'

cd "$(dirname "$0")/../.."
[ -f db/main/local/migrator.sql ] && [ -f scripts/db/migrate-locked.ts ] || {
  echo "Pokreni iz repoa Institution_server (nema db/main/local/migrator.sql)." >&2; exit 1; }
command -v psql >/dev/null || { echo "Nema psql (15 ili noviji) u PATH-u." >&2; exit 1; }
command -v perl >/dev/null || { echo "Nema perl u PATH-u." >&2; exit 1; }
echo "Institution_server @ $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)), $(psql --version)"

KORAK="${1:-}"

citaj_tajnu() { # $1 ime varijable, $2 upit
  local v
  read -rsp "$2: " v; echo
  [ -n "$v" ] || { echo "Prazno, stajem." >&2; exit 1; }
  printf -v "$1" '%s' "$v"; export "$1"
}

provjeri_url() { # $1 URL; migrate-locked dodaje &role=…, pa URL mora već imati upit
  case "$1" in
    postgres://*\?*|postgresql://*\?*) ;;
    *) echo "URL mora početi s postgres:// i imati upit (npr. ?sslmode=require)." >&2; exit 1;;
  esac
}

glavni_url() {
  if [ -z "${STG_MAIN_OWNER_URL:-}" ]; then
    citaj_tajnu STG_MAIN_OWNER_URL "External Database URL glavne baze (ductus) iz Rendera, s ?sslmode=require"
  fi
  provjeri_url "$STG_MAIN_OWNER_URL"
}

korak3() {
  glavni_url
  echo "== Korak 3: vlasnik baze"
  local red
  red=$(psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -At -c "SELECT rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user" | tr -d '\r')
  echo "rolcreaterole|rolbypassrls = $red"
  [ "${red%%|*}" = "t" ] || { echo "Vlasnik nema CREATEROLE: stani i javi orkestratoru (B0.1)." >&2; exit 1; }
  psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q \
    -c "SET createrole_self_grant = 'set, inherit'" \
    -c "DO \$\$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ductus_migrator') THEN
            CREATE ROLE ductus_migrator NOLOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
          END IF;
        END \$\$"
  psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q -f db/main/local/migrator.sql
  node scripts/db/migrate-locked.ts --url "$STG_MAIN_OWNER_URL&role=ductus_migrator"
  echo "== Korak 3 gotov."
}

# Prijava (LOGIN) koja nasljeđuje grupnu ulogu, bez SET; stvara je samo ako ne postoji, atribute i lozinku postavlja uvijek.
# $1 URL, $2 prijava, $3 grupna uloga, $4 ime varijable s lozinkom, $5 uloga pod kojom se stvara (prazno = vlasnik)
prijava() {
  psql "$1" -v ON_ERROR_STOP=1 -q -v prijava="$2" -v grupa="$3" -v kao="${5:-}" <<SQL
\getenv lozinka $4
SELECT :'kao' <> '' AS kao_uloga \gset
\if :kao_uloga
SET ROLE :"kao";
\endif
SELECT format('CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'prijava')
 WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'prijava') \gexec
SELECT format('ALTER ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'prijava', :'lozinka') \gexec
GRANT :"grupa" TO :"prijava" WITH INHERIT TRUE, SET FALSE;
RESET ROLE;
SQL
}

korak4() {
  glavni_url
  echo "== Korak 4: prijave u glavnoj bazi (lozinka najmanje 16 znakova, npr. openssl rand -base64 24)"
  citaj_tajnu STG_APP_PASSWORD "Lozinka za ductura_stg_app"
  citaj_tajnu STG_AUTH_PASSWORD "Lozinka za ductura_stg_auth"
  prijava "$STG_MAIN_OWNER_URL" ductura_stg_app ductus_app STG_APP_PASSWORD ductus_migrator
  prijava "$STG_MAIN_OWNER_URL" ductura_stg_auth ductus_auth STG_AUTH_PASSWORD ductus_migrator
  unset STG_APP_PASSWORD STG_AUTH_PASSWORD

  echo "== Baza zapisa ductus_logs"
  citaj_tajnu STG_LOGS_OWNER_URL "External Database URL baze zapisa (ductus_logs) iz Rendera, s ?sslmode=require"
  provjeri_url "$STG_LOGS_OWNER_URL"
  psql "$STG_LOGS_OWNER_URL" -v ON_ERROR_STOP=1 -q \
    -c "SET createrole_self_grant = 'set, inherit'" \
    -c "DO \$\$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ductus_logs_migrator') THEN
            CREATE ROLE ductus_logs_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;
        END \$\$"
  psql "$STG_LOGS_OWNER_URL" -v ON_ERROR_STOP=1 -q -f db/logs/local/migrator.sql
  node scripts/db/migrate-locked.ts --database logs --url "$STG_LOGS_OWNER_URL&role=ductus_logs_migrator"
  citaj_tajnu STG_LOGS_PASSWORD "Lozinka za ductura_stg_logs"
  prijava "$STG_LOGS_OWNER_URL" ductura_stg_logs ductus_logs_writer STG_LOGS_PASSWORD
  unset STG_LOGS_PASSWORD
  echo "== Korak 4 gotov. Za Render slaži URL-ove s INTERNAL hostom (korak 5 u docs/STAGING.md)."
}

korak6() {
  glavni_url
  local bypass
  bypass=$(psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -At -c "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user" | tr -d '\r')
  read -rp "Issuer lažnog OIDC servisa (isti kao OIDC_ISSUER na Renderu, https://...): " STG_OIDC_ISSUER
  export STG_OIDC_ISSUER
  case "$STG_OIDC_ISSUER" in https://*) ;; *) echo "Issuer mora početi s https://" >&2; exit 1;; esac
  echo "== Korak 6: seed (rolbypassrls=$bypass)"
  if [ "$bypass" = "t" ]; then
    trap 'psql "$STG_MAIN_OWNER_URL" -q -c "REVOKE ductus_identity, ductus_evidence, ductus_auth, ductus_app FROM CURRENT_USER"' EXIT
    psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q \
      -c "GRANT ductus_identity, ductus_evidence TO CURRENT_USER WITH INHERIT TRUE, SET TRUE" \
      -c "GRANT ductus_auth, ductus_app TO CURRENT_USER WITH INHERIT FALSE, SET TRUE"
    sed -e '/^\\set ON_ERROR_STOP on$/,/^\\endif$/d' db/main/local/seed.sql \
      | perl -0pe 's{\x27http://localhost:8090\x27}{\x27$ENV{STG_OIDC_ISSUER}\x27}g == 2 or die "issuer not found twice\n"' \
      | psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q
  else
    echo "rolbypassrls = f: ide samo prvi dio seeda (ustanove i issuer), bez administratora i kolegija (docs/STAGING.md, Otvoreno)."
    trap 'psql "$STG_MAIN_OWNER_URL" -q -c "REVOKE ductus_identity, ductus_evidence FROM CURRENT_USER"' EXIT
    psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q \
      -c "GRANT ductus_identity, ductus_evidence TO CURRENT_USER WITH INHERIT FALSE, SET TRUE"
    sed -e '/^\\set ON_ERROR_STOP on$/,/^\\endif$/d' -e '/^DO \$demo\$$/,$d' db/main/local/seed.sql \
      | perl -0pe '
          s{INSERT INTO evidence\.domain .*?;\n}{SELECT id AS stg_institution FROM identity.institution WHERE slug = \x27demo-fakultet\x27 \\gset\nSET ROLE ductus_evidence;\nINSERT INTO evidence.domain (institution_id, region)\nSELECT :\x27stg_institution\x27, \x27local\x27\n WHERE NOT EXISTS (SELECT 1 FROM evidence.domain WHERE institution_id = :\x27stg_institution\x27);\nRESET ROLE;\n}s or die "evidence.domain not found\n";
          s{\x27http://localhost:8090\x27}{\x27$ENV{STG_OIDC_ISSUER}\x27}g == 1 or die "issuer not found\n";' \
      | PGOPTIONS='-c role=ductus_identity' psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q
  fi
  echo "== Korak 6 gotov (privremena članstva uklanjaju se pri izlazu)."
}

case "$KORAK" in
  3) korak3;;
  4) korak4;;
  6) korak6;;
  sve) korak3; korak4; echo "Korak 6 (seed) pokreni zasebno kad lažni OIDC radi na Renderu: bash scripts/staging/baze.sh 6";;
  *) echo "Upotreba: bash scripts/staging/baze.sh 3|4|6|sve" >&2; exit 2;;
esac
