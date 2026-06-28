# 02 — Clean VPS Setup (Hetzner)

> Audience: an operator who can copy/paste and run commands. This guide turns a **fresh
> Hetzner VPS** into a host that is ready to build and run the Syndicate backend (guide `03`).
> Every step is **idempotent**: if something is already installed, the step detects it and
> skips. Run the steps in order.

This guide installs the **Docker‑based** runtime, which is the simplest reliable path for an
operator: Docker builds and runs every backend service for you, so you do **not** install
Rust/Node/Postgres directly on the host.

---

## 0. What you need before starting

- A Hetzner Cloud server (or dedicated) running **Ubuntu 22.04 or 24.04**.
  - Recommended size: **8 GB RAM / 4 vCPU / 80 GB disk** or larger. The backend compiles
    Rust services during the first deploy, which is memory‑hungry. **4 GB RAM is the
    minimum and requires the swap step (4.6).**
- SSH access to the server (Hetzner gives you a root password or you added an SSH key at
  creation time).
- Your own SSH **public key** on your laptop (file `~/.ssh/id_ed25519.pub` or similar). If
  you do not have one, on your laptop run: `ssh-keygen -t ed25519` and accept the defaults.

---

## 1. Connect to the server

From your laptop (replace with the server’s public IP from the Hetzner console):

```bash
# EDIT: <SERVER_IP>
ssh root@<SERVER_IP>
```

If this is the very first login with a password, Hetzner may force you to set a new root
password — do so and reconnect.

---

## 2. Update the operating system

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get install -y curl git ca-certificates ufw fail2ban
```

> If a kernel update prompts a reboot later, run `reboot`, wait ~30s, and `ssh` back in.

---

## 3. Create a non‑root deploy user

Running services as root is unsafe. Create a `deploy` user with sudo:

```bash
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
# Allow passwordless sudo for this deploy user (convenient for an operator):
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-deploy
chmod 0440 /etc/sudoers.d/90-deploy
```

### 3.1 Give the deploy user your SSH key

Run this **on your laptop** (not the server), replacing the IP:

```bash
# EDIT: <SERVER_IP>
ssh-copy-id deploy@<SERVER_IP>
```

If `ssh-copy-id` is unavailable, paste your laptop’s `~/.ssh/id_ed25519.pub` content into the
server manually:

```bash
# Run ON THE SERVER (as root):
mkdir -p /home/deploy/.ssh
# EDIT: paste your PUBLIC key string between the quotes on the next line
echo "ssh-ed25519 AAAA... your-key" >> /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

### 3.2 Verify you can log in as deploy

From your laptop, open a **new terminal** and confirm before locking down root:

```bash
# EDIT: <SERVER_IP>
ssh deploy@<SERVER_IP> 'echo login-ok'
```

You must see `login-ok`. **Do not proceed to Step 4 until this works.**

---

## 4. Harden SSH and the firewall

### 4.1 Disable root login and password auth (keys only)

Run on the server (as root):

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd
```

### 4.2 Configure the firewall (UFW)

We open only SSH and the HTTP/HTTPS ports (for a future reverse proxy). Backend service
ports are **not** opened to the public here.

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose
```

> **Important Docker caveat:** Docker manages its own iptables rules and **bypasses UFW** for
> any port it `publishes` to `0.0.0.0`. Guide `03` therefore binds backend ports to
> `127.0.0.1` (localhost) so they are not reachable from the internet. Do not publish backend
> ports on `0.0.0.0` unless you intend them to be public.

### 4.3 Enable fail2ban (basic SSH brute‑force protection)

```bash
systemctl enable --now fail2ban
systemctl status fail2ban --no-pager | head -n 5
```

---

## 5. Switch to the deploy user

Everything from here runs as `deploy`:

```bash
su - deploy
whoami   # should print: deploy
```

---

## 6. Install Docker Engine + Compose plugin

This is the official Docker apt repository method. It is idempotent.

```bash
if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
```

### 6.1 Let the deploy user run docker without sudo

```bash
sudo usermod -aG docker deploy
# Apply the new group to your current shell:
newgrp docker
```

### 6.2 Verify Docker works

```bash
docker --version
docker compose version
docker run --rm hello-world   # should print "Hello from Docker!"
```

---

## 7. Install git and a Postgres client (for migrations)

`git` was installed in Step 2. The Postgres client lets you run database migrations from the
host in guide `03`:

```bash
command -v git >/dev/null || sudo apt-get install -y git
command -v psql >/dev/null || sudo apt-get install -y postgresql-client
git --version
psql --version
```

---

## 8. Create the directory and secret layout

```bash
sudo mkdir -p /opt/syndicate /var/lib/syndicate /etc/syndicate
sudo chown -R deploy:deploy /opt/syndicate /var/lib/syndicate
sudo chmod 750 /etc/syndicate
```

- `/opt/syndicate` — where the repository will be cloned (guide `03`).
- `/var/lib/syndicate` — runtime data (e.g., replay files).
- `/etc/syndicate` — reference location for secrets (the Docker path mounts secrets from the
  repo’s `deploy/secrets/` directory; see guide `03`).

---

## 9. (Required only for ≤ 4 GB RAM) Add swap

Skip if your server has ≥ 8 GB RAM. On smaller servers this prevents the Rust build in
guide `03` from being killed by the out‑of‑memory killer.

```bash
if [ ! -f /swapfile ]; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi
free -h   # confirm a Swap line with ~4Gi
```

---

## 10. Verify the host is ready

```bash
echo "OS:";        . /etc/os-release && echo "  $PRETTY_NAME"
echo "docker:";    docker --version
echo "compose:";   docker compose version
echo "git:";       git --version
echo "psql:";      psql --version
echo "user:";      whoami
echo "dirs:";      ls -ld /opt/syndicate /var/lib/syndicate /etc/syndicate
echo "firewall:";  sudo ufw status | head -n 5
```

If every line prints a value (no “command not found”), the VPS is ready.

Proceed to [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md). See [README.md](./README.md) for cluster-specific notes.

---

## Appendix A — If the VPS already has some things installed

This guide is safe to run on a partially‑configured host:

- **Docker already installed** → Step 6’s `if ! command -v docker` skips the install; still
  run Steps 6.1–6.2 to ensure the `deploy` user is in the `docker` group.
- **A non‑root user already exists** → use it instead of `deploy`; substitute its name
  wherever this guide and guide `03` say `deploy`.
- **UFW already enabled** → Step 4.2 only adds rules; re‑running is harmless.
- **Swap already present** (`free -h` shows Swap) → skip Step 9.

## Appendix B — Optional: native (non‑Docker) runtime

Guide `03` uses Docker. If you are explicitly asked to run services **without** Docker (via
`systemd`, using the units in `docs/deployment/systemd/`), you would instead install on the
host: Node.js 22, the Rust toolchain, and `postgresql-client`, then build the Rust binaries
with `cargo build --release`. The Docker path in guide `03` is recommended and complete for
all services; only follow this appendix if specifically instructed.
