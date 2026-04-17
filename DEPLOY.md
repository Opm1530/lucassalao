# Deploy — Docker + Git

## Pré-requisitos no VPS
- Docker instalado (`docker -v`)
- Docker Compose instalado (`docker compose version`)
- Git instalado (`git -v`)
- Porta 3000 liberada no firewall

---

## Primeira vez

### 1. Clonar o repositório
```bash
git clone https://github.com/seu-usuario/seu-repo.git /opt/lais-bot
cd /opt/lais-bot
```

### 2. Criar o arquivo .env
```bash
cp .env.example .env
nano .env
```

Preencha com seus valores reais:
```env
PORT=3000
DATABASE_URL=postgresql://default:Ginanye123@host.docker.internal:5432/lucassalao

# Login do dashboard — troque a senha
DASHBOARD_USER=admin
DASHBOARD_PASS=SuaSenhaForteAqui

# String aleatória longa — gere com o comando abaixo
SESSION_SECRET=cole-aqui-a-string-gerada
```

> Gerar SESSION_SECRET:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

> **Atenção no DATABASE_URL:** dentro do Docker, use `host.docker.internal` no lugar do IP do VPS para acessar o PostgreSQL que roda no próprio host. O `docker-compose.yml` já configura isso automaticamente.

### 3. Subir o container
```bash
docker compose up -d --build
```

### 4. Verificar se está rodando
```bash
docker compose ps
docker compose logs -f
```

Acesse `http://SEU_IP:3000` — deve redirecionar para o login.

---

## Atualizar após mudanças no código

```bash
cd /opt/lais-bot
git pull
docker compose up -d --build
```

O container antigo é substituído automaticamente. Zero downtime na prática para esse tipo de app.

---

## Comandos úteis

```bash
docker compose ps                  # status do container
docker compose logs -f             # logs em tempo real
docker compose logs --tail 50      # últimas 50 linhas
docker compose restart lais-bot    # reiniciar sem rebuild
docker compose down                # parar e remover container
docker compose up -d --build       # rebuildar e subir
```

---

## Configurar webhook na Evolution API

No dashboard (aba WhatsApp) configure o webhook como:
```
http://SEU_IP:3000/webhook/evolution
```

---

## (Opcional) Nginx + HTTPS com domínio

Se tiver um domínio apontando pro VPS:

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
sudo nano /etc/nginx/sites-available/lais-bot
```

```nginx
server {
    listen 80;
    server_name seudominio.com.br;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/lais-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d seudominio.com.br
```

Com HTTPS, atualize o webhook na Evolution para `https://seudominio.com.br/webhook/evolution`.
