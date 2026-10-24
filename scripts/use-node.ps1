# Dot-source for this PowerShell session: . ./scripts/use-node.ps1
$vaultmedAppRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vaultmedPortableNode = Join-Path $vaultmedAppRoot '.tools/node-v24.22.1-win-x64'
if (Test-Path -LiteralPath (Join-Path $vaultmedPortableNode 'node.exe')) {
    $env:PATH = $vaultmedPortableNode + [IO.Path]::PathSeparator + $env:PATH
}
$vaultmedNodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or $vaultmedNodeVersion -notmatch '^24\.') {
    throw 'VaultMed requires Node.js 24. Install Node 24 or use the local portable runtime.'
}
Write-Output "VaultMed Node $vaultmedNodeVersion is active for this PowerShell session."
