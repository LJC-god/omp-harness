# Native PostgreSQL lab runtime

This is a lab-only Windows lifecycle wrapper. It finds the nearest valid `.omp-automation-lab-root` above its own script and accepts a runtime root only below that marker, which itself must be a strict child of `D:\Labs\omp`. It never registers a Windows service or kills processes; `pg_ctl stop` addresses only its marked data directory. It requires an already verified PostgreSQL `bin` directory, downloads nothing, and never starts Docker.

First make a new directory under `D:\Labs\omp`, write an `omp-automation-lab/v1` marker into `.omp-automation-lab-root`, then copy this script into that lab's `scripts` directory. Set an explicit verified PostgreSQL `bin` directory and a new dedicated `runtime` child directory. The wrapper has no binary default. The experimental `@embedded-postgres/windows-x64` package used during this lab’s validation is not a production recommendation.

```powershell
# One-time lab setup
$lab = 'D:\Labs\omp\my-native-postgres-lab'
New-Item -ItemType Directory -Force "$lab\scripts", "$lab\runtime" | Out-Null
Set-Content -NoNewline "$lab\.omp-automation-lab-root" 'omp-automation-lab/v1'
Copy-Item .\scripts\native-postgres.mjs "$lab\scripts\native-postgres.mjs"

# Run only from the lab copy
Set-Location $lab
$env:OMP_POSTGRES_BIN = 'C:\verified-postgresql\bin'
$env:OMP_POSTGRES_RUNTIME_ROOT = "$lab\runtime\pg18"
node .\scripts\native-postgres.mjs start
$env:TEST_DATABASE_URL = (node .\scripts\native-postgres.mjs url | ConvertFrom-Json).databaseUrl
# Run the consumer with its explicit TEST_DATABASE_URL.
node .\scripts\native-postgres.mjs stop
```

`start` and `status` redact credentials. Only `url` emits a connection URL; it refuses unmarked roots and never creates files. `with -- command...` passes `DATABASE_URL` to one headless consumer, preserves any explicit `TEST_DATABASE_URL`, and stops only a cluster it freshly started. Windows cancellation cannot guarantee consumer-process cleanup without a Job Object.
