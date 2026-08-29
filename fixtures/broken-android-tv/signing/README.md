# Controlled fixture signing

`fixture-debug.p12` is a repository-owned, password-`android` test key used only
to make the deliberately broken Android TV fixture upgradeable and reproducible
across local and hosted runs. It is not trusted for the TVDoctor observer or any
release artifact.
