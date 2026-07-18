{pkgs}: {
  deps = [
    pkgs.xorg.xdpyinfo
    pkgs.python3
    pkgs.chromium
    pkgs.novnc
    pkgs.x11vnc
    pkgs.xorg.xorgserver
  ];
}
