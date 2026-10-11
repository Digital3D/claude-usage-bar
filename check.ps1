# Build entry point: validates the mod and runs its tests. Exit 0 when all pass.
$ErrorActionPreference = 'Stop'

claude plugin validate "$PSScriptRoot/usage-bar"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

claude plugin test "$PSScriptRoot/usage-bar"
exit $LASTEXITCODE
