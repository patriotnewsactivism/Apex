# SearXNG + search router: Contabo deploy & rollback runbook

Do not run any of this until Matthew approves. VPS: `ssh -i ~/.ssh/contabo_apex root@144.126.142.194`. SSH is rate-limited, so run each phase in one session.
`D=/home/hermes/.hermes/railway-exit/deploy`. Never build from `/home/hermes/apex`, because that checkout is dirty.

## 0. On the box: package a clean tree of the PR commit
```bash
SHA=<PR head sha>; S=${SHA:0:7}
cd /workspace/apex-searx && git fetch origin && git archive --format=tar.gz -o /workspace/apex-$S.tar.gz $SHA
scp -i ~/.ssh/contabo_apex /workspace/apex-$S.tar.gz root@144.126.142.194:/root/
```

## 1. VPS: rollback tag + compose backup
```bash
set -euo pipefail; D=/home/hermes/.hermes/railway-exit/deploy; cd $D
TS=$(date +%Y%m%d-%H%M%S); echo $TS > /root/searxng-deploy.ts
docker tag apex:contabo apex:contabo-prev-searxng-$TS
cp -a docker-compose.yml docker-compose.yml.bak.searxng-$TS
docker inspect apex-contabo-apex-1 --format '{{.Image}} RO={{.HostConfig.ReadonlyRootfs}}' | tee /root/apex-pre-$TS.txt
```

## 2. VPS: unpack, place config, generate the secret, apply the compose diff
```bash
S=<short sha>; B=/root/apex-build-$S; rm -rf $B; mkdir -p $B; tar -xzf /root/apex-$S.tar.gz -C $B
mkdir -p $D/searxng && cp $B/deploy/contabo/searxng/{settings.yml,limiter.toml} $D/searxng/
( umask 077; printf 'SEARXNG_SECRET=%s\n' "$(openssl rand -hex 32)" > $D/searxng.env )
chown -R hermes:hermes $D/searxng $D/searxng.env
cd $D && patch -p1 --dry-run < $B/deploy/contabo/searxng/compose.diff && patch -p1 < $B/deploy/contabo/searxng/compose.diff
docker compose config -q && echo COMPOSE_OK
```

## 3. VPS: start searxng + valkey only (apex/caddy untouched)
```bash
cd $D && docker compose up -d --no-build searxng-valkey searxng
docker compose ps searxng searxng-valkey
docker port apex-contabo-searxng-1 || true      # must print nothing
ss -ltnp | grep -E ':8080|:6379' || echo "no host listeners (good)"
```

## 4. VPS: test query from inside the running APEX container
```bash
docker exec apex-contabo-apex-1 node -e "fetch('http://searxng:8080/search?q=roofing+contractor+dallas&format=json',{headers:{'X-Forwarded-For':'127.0.0.1'}}).then(r=>r.json()).then(j=>console.log('results',j.results.length,'unresponsive',JSON.stringify(j.unresponsive_engines)))"
```
You need at least 5 results. If you get 0, check `docker logs apex-contabo-searxng-1 --tail 100` and stop here. Apex is still on the old image, so nothing needs to be rolled back yet.

## 5. VPS: build the APEX image from the clean archive
```bash
docker build -t apex:searxng-$S -f $B/Dockerfile $B
docker tag apex:searxng-$S apex:contabo
```

## 6. VPS: recreate apex only, keeping the lockdown
```bash
cd $D && docker compose up -d --no-deps --no-build --force-recreate apex
docker inspect apex-contabo-apex-1 --format 'RO={{.HostConfig.ReadonlyRootfs}} {{range .Mounts}}{{.Destination}} {{end}}'
# expect RO=true and /workspace /data/artifacts /root/.cache plus the model cache
docker exec apex-contabo-apex-1 sh -c 'echo $SEARXNG_URL; touch /app/x 2>&1 | head -1'   # http://searxng:8080; "Read-only file system"
```

## 7. Box: re-apply the Cartesia hotfix
```bash
cd /workspace/voice-latency/fix && python3 /workspace/serper-rotate/apply_hotfix.py
```

## 8. Verification
```bash
docker compose ps; docker logs apex-contabo-apex-1 --since 5m 2>&1 | grep -Ei 'error|webSearch|search-router' | tail -30
docker exec apex-contabo-apex-db-1 psql -U apex -d apex -c "select provider,count(*) from lead_search_cache where updated_at>now()-interval '1 hour' group by 1;"
docker exec apex-contabo-apex-db-1 psql -U apex -d apex -c "select day,account,requests from llm_request_usage_daily where day like 'mo:%';"
curl -sS -o /dev/null -w '%{http_code}\n' https://<apex public host>/api/health   # through Caddy
curl -m5 http://144.126.142.194:8080/ || echo "searxng not reachable from outside (good)"
```

## Rollback (any step after 5)
```bash
TS=$(cat /root/searxng-deploy.ts); cd $D
docker tag apex:contabo-prev-searxng-$TS apex:contabo
cp -a docker-compose.yml.bak.searxng-$TS docker-compose.yml
docker compose up -d --no-deps --no-build --force-recreate apex
docker rm -f apex-contabo-searxng-1 apex-contabo-searxng-valkey-1
docker network rm apex-contabo_searxnet || true
docker inspect apex-contabo-apex-1 --format '{{.Image}} RO={{.HostConfig.ReadonlyRootfs}}'   # compare with /root/apex-pre-$TS.txt
# then re-run step 7 (Cartesia hotfix) from the box
```
Without SEARXNG_URL, the old code ignores SearXNG. The new `mo:` ledger rows don't hurt anything.
