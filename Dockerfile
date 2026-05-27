# 1. Start with an official Nvidia Linux image
FROM nvidia/cuda:12.1.1-base-ubuntu22.04

# 2. Install Python, pip, and the Linux display/runtime libraries Blender needs
RUN apt-get update && apt-get install -y \
    ca-certificates \
    python3 \
    python3-pip \
    wget \
    xz-utils \
    libxrender1 \
    libxi6 \
    libxkbcommon0 \
    libx11-6 \
    libgl1 \
    libgl1-mesa-glx \
    libglu1-mesa \
    libegl1 \
    libsm6 \
    libxext6 \
    libxfixes3 \
    libxxf86vm1 \
    libxrandr2 \
    libxinerama1 \
    libxcursor1 \
    libfontconfig1 \
    libfreetype6 \
    libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

# 3. Download and install Blender 4.0
RUN wget https://download.blender.org/release/Blender4.0/blender-4.0.2-linux-x64.tar.xz \
    && tar -xvf blender-4.0.2-linux-x64.tar.xz -C /opt/ \
    && mv /opt/blender-4.0.2-linux-x64 /opt/blender \
    && ln -s /opt/blender/blender /usr/local/bin/blender \
    && rm blender-4.0.2-linux-x64.tar.xz

# 4. Keep CUDA kernel caches in writable /tmp for RunPod workers and default to GPU rendering
ENV CUDA_CACHE_PATH=/tmp/cuda-cache \
    CUDA_MODULE_LOADING=LAZY \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics \
    RENDER_GPU_DEVICE_TYPE=AUTO \
    RENDER_ALLOW_CPU_FALLBACK=false \
    RENDER_FORCE_CPU=false

# 5. Install the Python packages
RUN pip3 install --no-cache-dir runpod boto3

# 6. Copy your handler
COPY handler.py /handler.py

# 7. Start the listener
CMD ["python3", "/handler.py"]