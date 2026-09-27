# The OMS on the ThinkPad and its fallback, end to end (see compose.yml). From this folder,
# after `docker compose build`. Leaves the stack running; `docker compose down -v` when done.
set -u
C="docker compose"
W=http://localhost:18787
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $*"; }
bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
servedby() { curl -s --compressed -o /dev/null -D - "$@" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-paribelle-served-by"{print $2}'; }
status() { $C exec -T sync node src/main.ts status 2>/dev/null; }
job() { status | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s).jobs.find(j=>j.name==='oms-orders');console.log(JSON.stringify(j))})"; }
waitfor() { # description, command; up to 120 s
  for i in $(seq 1 120); do eval "$2" >/dev/null 2>&1 && { echo "  ..   $1 (${i}s)"; return 0; }; sleep 1; done
  bad "timed out: $1"; return 1
}

$C down -v >/dev/null 2>&1
$C up -d local cloud >/dev/null 2>&1
$C run --rm schema >/dev/null 2>&1 || { echo "schema failed"; $C run --rm schema; exit 1; }
$C run --rm sync node src/main.ts bootstrap oms >/dev/null 2>&1 || { echo "bootstrap failed"; exit 1; }
$C up -d sync oms vercel gate worker >/dev/null 2>&1
waitfor "the Worker answers" "curl -sf --compressed $W/pom/api/health"
waitfor "the ThinkPad serves" "[ \"\$(servedby $W/pom/login)\" = thinkpad ]"

echo "ThinkPad up"
check "the login page, from the ThinkPad" "curl -s --compressed $W/pom/login | grep -q 'Paribelle OMS'"
check "its health: the ThinkPad's own database and release" "curl -s --compressed $W/pom/api/health | grep -q '\"release\":\"e2e\"'"
check "the OMS runs as 4 processes" "$C logs oms 2>&1 | grep -q 'starting 4 processes' && [ \"\$($C exec -T oms sh -c 'ls /proc | grep -c \"^[0-9]*$\"')\" -ge 5 ]"
codes=$(for i in $(seq 1 24); do curl -s -o /dev/null -w '%{http_code}\n' $W/pom/login & done; wait)
check "24 pages at once: all 200" "[ \"\$(echo \"\$codes\" | grep -c 200)\" = 24 ]"
cookie=$($C run --rm --no-deps -T -e AUTH_SECRET=e2e-auth-secret-e2e-auth-secret-0123456789 schema node -e "
  const {SignJWT}=require('jose');
  new SignJWT({uid:1,role:'owner'}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET)).then(t=>process.stdout.write(t))")
check "a signed-in page (orders) on the ThinkPad" "curl -s --compressed -b oms_session=$cookie $W/pom/orders -o /dev/null -w '%{http_code}' | grep -q 200"
waitfor "the order-sync job has run" "job | grep -q '\"lastStatus\":200'"
check "... with its token; without one the OMS refuses" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $W/pom/api/cron/sync)\" = 401 ]"
check "the storefront's paths go to the storefront (not running here: the fallback answers)" "[ \"\$(servedby $W/)\" = fallback ]"
check "without the edge key the gate lets nothing in" "[ \"\$($C exec -T sync node -e \"fetch('http://gate:8080/pom/login').then(r=>console.log(r.status))\")\" = 403 ]"

echo "ThinkPad's OMS stopped"
$C stop oms >/dev/null 2>&1
waitfor "requests go to Vercel" "[ \"\$(servedby $W/pom/login)\" = fallback ]"
check "the fallback's health: Vercel's release, the cloud database" "curl -s --compressed $W/pom/api/health | grep -q '\"release\":\"vercel\"'"
check "the same sign-in works there (one AUTH_SECRET)" "curl -s --compressed -b oms_session=$cookie $W/pom/orders -o /dev/null -w '%{http_code}' | grep -q 200"
waitfor "the job waits while the ThinkPad isn't serving the OMS" "job | grep -q \"isn't serving oms\""
$C exec -T cloud psql -U postgres -d oms -qc "insert into users (email, name, password_hash) values ('while-away@example.com', 'Written on Vercel', 'x')" >/dev/null

echo "ThinkPad's OMS back"
$C start oms >/dev/null 2>&1
waitfor "the ThinkPad serves again" "[ \"\$(servedby $W/pom/login)\" = thinkpad ]"
check "what Vercel wrote was home before it did" "$C exec -T local psql -U paribelle -d oms -tAc \"select count(*) from users where email = 'while-away@example.com'\" | grep -qx 1"
status > /tmp/sync-status.json
check "the sync: ready, apps up, no conflicts" "grep -q '\"ready\": true' /tmp/sync-status.json && grep -q '\"appsUp\": true' /tmp/sync-status.json && grep -q '\"openConflicts\": 0' /tmp/sync-status.json"

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
