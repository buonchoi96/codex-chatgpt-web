!macro preInit
  ; Custom per-user build: default the application to E:\Codex Web GPT\App.
  ; Data is kept in the sibling E:\Codex Web GPT\Data directory by the launcher,
  ; so uninstalling/replacing App does not own or erase the durable profile.
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "E:\Codex Web GPT\App"
  SetRegView 32
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "E:\Codex Web GPT\App"
!macroend
