# Offline draft voice: Windows SAPI renders each job to a 24 kHz mono WAV (no network, no downloads).
# Input: JSON file [{id, text, rate, out}], used by tts/draft.py. These are DRAFTS that make the whole film watchable
# on a machine that cannot run OmniVoice at a useful speed; `cli.py gen` replaces them with OmniVoice takes.
param([Parameter(Mandatory = $true)][string]$JobsFile, [string]$Voice = "")
Add-Type -AssemblyName System.Speech
$jobs = Get-Content -Raw -Encoding UTF8 $JobsFile | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice) { $synth.SelectVoice($Voice) }
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($j in $jobs) {
  $synth.Rate = [int]$j.rate
  $synth.SetOutputToWaveFile($j.out, $fmt)
  $synth.Speak([string]$j.text)
  $synth.SetOutputToNull()
  Write-Output ("[draft] " + $j.id + " -> " + $j.out)
}
$synth.Dispose()
