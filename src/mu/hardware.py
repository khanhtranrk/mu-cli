"""Small, dependency-free probes for compute GPUs and their VRAM."""

from dataclasses import dataclass
import re
import shutil
import subprocess


GIB = 1024**3
VRAM_PER_UNIT_GIB = 4


@dataclass(frozen=True)
class ComputeDevice:
    index: str
    name: str
    vram_gib: float
    backend: str

    @property
    def capacity_units(self) -> float:
        return self.vram_gib / VRAM_PER_UNIT_GIB


def detect_devices() -> list[ComputeDevice]:
    """Detect NVIDIA via nvidia-smi and AMD via rocm-smi when available."""
    nvidia = _detect_nvidia()
    if nvidia:
        return nvidia
    return _detect_rocm()


def _run(executable: str, *args: str) -> str | None:
    path = shutil.which(executable)
    if not path:
        return None
    try:
        result = subprocess.run([path, *args], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout if result.returncode == 0 else None


def _detect_nvidia() -> list[ComputeDevice]:
    output = _run("nvidia-smi", "--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits")
    if not output:
        return []
    devices: list[ComputeDevice] = []
    for line in output.splitlines():
        parts = [part.strip() for part in line.split(",", 2)]
        if len(parts) != 3:
            continue
        try:
            devices.append(ComputeDevice(parts[0], parts[1], float(parts[2]) / 1024, "nvidia"))
        except ValueError:
            continue
    return devices


def _detect_rocm() -> list[ComputeDevice]:
    output = _run("rocm-smi", "--showproductname", "--showmeminfo", "vram")
    if not output:
        return []
    # rocm-smi emits one GPU block with a VRAM Total Memory (B) field per card.
    blocks = re.split(r"(?=GPU\[\d+\])", output, flags=re.IGNORECASE)
    devices: list[ComputeDevice] = []
    for block in blocks:
        index_match = re.search(r"GPU\[(\d+)\]", block, flags=re.IGNORECASE)
        memory_match = re.search(r"(?:VRAM\s+)?Total Memory\s*\(B\)\s*:\s*([\d,]+)", block, flags=re.IGNORECASE)
        name_match = re.search(r"Card series\s*:\s*(.+)", block, flags=re.IGNORECASE)
        if not index_match or not memory_match:
            continue
        try:
            memory = int(memory_match.group(1).replace(",", "")) / GIB
        except ValueError:
            continue
        devices.append(ComputeDevice(index_match.group(1), name_match.group(1).strip() if name_match else "AMD GPU", memory, "rocm"))
    return devices


def linux_integrated_gpu_names() -> list[str]:
    """Best-effort labels for display GPUs that have no compute VRAM probe."""
    path = shutil.which("lspci")
    if not path:
        return []
    try:
        result = subprocess.run([path], capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [line.split(": ", 1)[-1].strip() for line in result.stdout.splitlines()
            if re.search(r"VGA compatible controller|3D controller|Display controller", line, re.IGNORECASE)]
