#!/bin/bash
# publish.sh - Publica uma nova versão da imagem Docker

# Cores para output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}📦 Publicando nova versão do LinkManager...${NC}"

# Perguntar o número da versão
read -p "Número da versão (ex: 1.0.1): " VERSION

if [ -z "$VERSION" ]; then
    echo -e "${YELLOW}Nenhuma versão fornecida. Apenas atualizando 'latest'...${NC}"
    VERSION=""
fi

# Fazer login (se necessário)
echo -e "${YELLOW}🔑 Verificando login no Docker Hub...${NC}"
docker login

# Construir e publicar
if [ -z "$VERSION" ]; then
    # Apenas latest
    docker buildx build \
        --platform linux/amd64,linux/arm64,linux/arm/v7 \
        -t fro103/linkmanager:latest \
        --push .
else
    # Latest + versão específica
    docker buildx build \
        --platform linux/amd64,linux/arm64 \
        -t fro103/linkmanager:latest \
        -t fro103/linkmanager:$VERSION \
        --push .
fi

echo -e "${GREEN}✅ Imagem publicada com sucesso!${NC}"
echo -e "  - fro103/linkmanager:latest"
[ -n "$VERSION" ] && echo -e "  - fro103/linkmanager:$VERSION"
