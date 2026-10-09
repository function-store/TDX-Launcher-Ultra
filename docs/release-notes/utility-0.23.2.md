A Registry page replaces the Palette page. It starts with Menu Bar Icon,
on by default: the small TDXLU button the companion puts in
TouchDesigner's menu bar, beside the path field, which opens these
parameters. Turn it off to hide the button; the palette-tab controls sit
under it, unchanged, and a read-only Command Registry line shows the
version of the command registry the companion carries.

The bundled registries are FunctionStore's published artifacts:
FNS_CommandRegistry 3.2.1 (v3.2.15) with TouchDesigner's built-in
commands for Quick Launch, and FNS_MainMenuRegistry 3.2.0 behind the
menu-bar button. A project that also installs them from the FNSTools
store resolves to one registry, so nothing is listed twice.

The command registry now labels each copy of a tool that lives as
several copies, so Quick Launch can tell their commands apart.
