# Dot-source for this PowerShell session: . ./scripts/use-node.ps1
$vellumAppRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vellumPortableNode = Join-Path $vellumAppRoot '.tools/node-v24.22.1-win-x64'
if (Test-Path -LiteralPath (Join-Path $vellumPortableNode 'node.exe')) {
    $env:PATH = $vellumPortableNode + [IO.Path]::PathSeparator + $env:PATH
}
$vellumNodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or $vellumNodeVersion -notmatch '^24\.') {
    throw 'Vellum requires Node.js 24. Install Node 24 or use the local portable runtime.'
}
Write-Output "Vellum Node $vellumNodeVersion is active for this PowerShell session."
