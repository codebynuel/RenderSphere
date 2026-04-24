# 1. Start with an official Nvidia Linux image so we have GPU drivers ready
FROM nvidia/cuda:12.1.1-base-ubuntu22.04

# 2. Install Python, pip, and the background libraries Blender needs to run
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
    && rm -rf /var/lib/apt/lists/*

# 3. Download and install Blender 4.0 directly from their official servers
RUN wget https://download.blender.org/release/Blender4.0/blender-4.0.2-linux-x64.tar.xz \
    && tar -xvf blender-4.0.2-linux-x64.tar.xz -C /opt/ \
    && mv /opt/blender-4.0.2-linux-x64 /opt/blender \
    && ln -s /opt/blender/blender /usr/local/bin/blender \
    && rm blender-4.0.2-linux-x64.tar.xz

# 4. Install the Python packages our handler.py script needs
RUN pip3 install runpod boto3

# 5. Copy your handler.py script from your PC into the container
COPY handler.py /handler.py

# 6. Tell the container to start our listener script when it boots up
CMD ["python3", "/handler.py"]