#!/bin/bash

# publish.sh - Script para publicar o projeto no Git e Docker Hub

# Cores para a saída
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # Sem cor

log() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[AVISO]${NC} $1"; }
error() { echo -e "${RED}[ERRO]${NC} $1"; }

# Verifica dependências
for cmd in git docker; do
    if ! command -v $cmd &> /dev/null; then
        error "$cmd não está instalado. Por favor, instale-o antes de executar este script."
        exit 1
    fi
done

echo "--------------------------------------------------"
echo " Script de Publicação do Projeto"
echo "--------------------------------------------------"

# 1. Entradas do usuário
read -p "https://github.com/FRO102/LinkManager" GIT_URL
read -p "fro103/link-manager:latest" DOCKER_IMAGE

if [[ -z "$GIT_URL" || -z "$DOCKER_IMAGE" ]]; then
    error "A URL do Git e o nome da imagem Docker são obrigatórios."
    exit 1
fi

# 2. Publicação no Git
echo -e "\n--- Publicando no Git ---"
if [ ! -d ".git" ]; then
    log "Inicializando repositório git..."
    git init
fi

log "Adicionando arquivos e criando commit..."
git add .

# Verifica se há mudanças para commitar
if git diff-index --quiet HEAD -- 2>/dev/null; then
    log "Nenhuma mudança para commitar."
else
    git commit -m "Publicação do projeto: $(date +'%Y-%m-%d %H:%M:%S')"
fi

# Configura o remote origin
if git remote | grep -q "origin"; then
    log "Atualizando URL do origin existente..."
    git remote set-url origin "$GIT_URL"
else
    log "Adicionando remote origin..."
    git remote add origin "$GIT_URL"
fi

log "Enviando para o branch principal..."
# Tenta enviar para 'main', se falhar tenta 'master'
if git push -u origin main; then
    log "Sucesso ao enviar para o branch main."
elif git push -u origin master; then
    log "Sucesso ao enviar para o branch master."
else
    warn "Falha ao enviar para o Git. Verifique suas credenciais e permissões do repositório."
fi

# 3. Publicação no Docker
echo -e "\n--- Publicando no Docker ---"
log "Construindo imagem Docker $DOCKER_IMAGE..."
if docker build -t "$DOCKER_IMAGE" .; then
    log "Enviando imagem para o registry..."
    if docker push "$DOCKER_IMAGE"; then
        log "Sucesso ao enviar a imagem para o Docker Registry!"
    else
        error "Falha ao enviar a imagem. Você executou 'docker login'?"
    fi
else
    error "Falha na construção da imagem Docker."
fi

echo -e "\n--------------------------------------------------"
echo -e "${GREEN}Processo de publicação concluído!${NC}"
echo "--------------------------------------------------"
