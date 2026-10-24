$ErrorActionPreference = 'Stop'
$pythonRuntime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path -LiteralPath $pythonRuntime)) {
    throw 'The Python runtime used to install this project was not found.'
}

$env:CRAWL4_AI_BASE_DIRECTORY = $PSScriptRoot
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PSScriptRoot '.browsers'
Push-Location $PSScriptRoot
try {
    & $pythonRuntime -X utf8 -c "import sys, runpy; sys.path.insert(0, '.test-deps'); runpy.run_path('crawler.py', run_name='__main__')"
    if ($LASTEXITCODE -ne 0) {
        throw "Crawler failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}
