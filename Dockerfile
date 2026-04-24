# 1. Start with an official Nvidia Linux image
FROM nvidia/cuda:12.1.1-base-ubuntu22.04

# 2. Install Python, pip, and the Linux display libraries Blender needs
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    wget \
    libxrender1 \
    libxi6 \
    libxkbcommon0 \
    libx11-6 \
    libgl1-mesa-glx \
    xz-utils \
    libsm6 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

# 3. Download and install Blender 4.0
RUN wget https://download.blender.org/release/Blender4.0/blender-4.0.2-linux-x64.tar.xz \
    && tar -xvf blender-4.0.2-linux-x64.tar.xz -C /opt/ \
    && mv /opt/blender-4.0.2-linux-x64 /opt/blender \
    && ln -s /opt/blender/blender /usr/local/bin/blender \
    && rm blender-4.0.2-linux-x64.tar.xz

# 4. Install the Python packages
RUN pip3 install runpod boto3

# 5. Copy your handler
COPY handler.py /handler.py

# 6. Start the listener
CMD ["python3", "/handler.py"]