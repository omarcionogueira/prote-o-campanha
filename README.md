# Proteção de tráfego na Cloudflare

Worker independente do Facebook Beta. Não altera conteúdo por perfil do visitante,
não interfere na revisão de anúncios e não usa o mecanismo de foco/teclado.

## Publicação verificada

- Worker: `cerberus-traffic-guard`.
- Domínio ativo: `promocao.wepink.website`, modo `enforce`.
- Saúde: `https://cerberus-traffic-guard.vangod23.workers.dev/health`.
- Banco D1 privado: `cerberus-traffic-guard-logs`.
- Identificadores públicos da instalação: `deployment.json`. Não contém credenciais.
- Teste remoto: página inicial 200; `/.git/config` 403; evento de bloqueio confirmado
  no D1 com IP, país BR, ASN, dispositivo estimado e motivo `private_file_probe`.
- O evento de teste tem User-Agent `Cerberus-Guard-Smoke-Test/1.0`; não é evidência
  de abuso real nem deve motivar bloqueio do IP de quem publicou.

## Comportamento e limites desta versão

- Bloqueia acessos a `/.git` e seus arquivos, e `/.env` e variantes estreitas.
- Limita a 120 navegações por 60 segundos por domínio/IP usando o binding nativo.
  Conta GET com Accept text/html ou Sec-Fetch-Dest document. Não é limite de todos
  os endpoints nem detector completo de automação; cabeçalhos podem ser falsificados.
- Esse limite é aproximado e local ao ponto de presença da Cloudflare, não global.
  IPs de redes móveis podem ser compartilhados; revisar falsos positivos antes de
  reduzir o limite. Bots verificados pela Cloudflare não passam por esse limite.
  User-Agent declarando ser um bot conhecido não concede exceção.
- Permite regras de IP individuais por domínio, revisadas, com expiração de até
  30 dias. Permissão explícita precede filtros; bloqueio explícito prevalece.
- Registra toda decisão blocked/would_block que chega a este Worker e consegue ser
  persistida. Não registra todas as visitas aprovadas e não vê requisições que o WAF
  ou outra camada da Cloudflare bloqueia antes da execução.
- Sem CAPTCHA, Turnstile ou Fingerprint Pro nesta primeira versão. Não confundir
  controle de abuso com comprovação de humanidade ou recuperação de cobrança de anúncios.
- País e ASN vêm de request.cf; dispositivo é estimativa do User-Agent, não identidade
  comprovada. Dados ausentes ficam nulos. Bot score só é salvo quando a conta o fornece;
  não é requisito nem critério de bloqueio desta versão.
- Não há importação automática das antigas listas do Facebook Beta nem promoção
  automática de acessos reprovados para a lista de bloqueio.

Referência do rate limiter:
https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

## Logs e armazenamento

`events` salva data/hora, domínio, IP, país, região/cidade quando disponíveis, ASN,
operadora/rede, dispositivo estimado, User-Agent truncado, caminho sem query string,
método, motivo, ação e Ray ID. Não salva corpo, cookies, Authorization ou query string.
Não existe endpoint público de logs. Consultas exigem autenticação Cloudflare.

Não há exclusão automática dos eventos. O armazenamento não é ilimitado: acompanhar
uso e limites do D1 e exportar/arquivar quando necessário. Nesta versão não há fila
durável de repetição. Se uma escrita D1 falhar, o evento vai como fallback aos Workers
Logs, cuja retenção depende da conta; não se garante persistência integral em falhas.
Falha ao ler configuração libera a origem e emite erro operacional. Falha de gravação
não libera uma requisição já classificada para bloqueio.

## Operação local

Node 20 ou superior. Configure somente no ambiente do processo:
`CLOUDFLARE_API_TOKEN` ou `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`.
Não coloque credenciais no repositório nem nos parâmetros dos comandos abaixo.

```sh
node --test --test-isolation=none test/worker.test.js
node manage.mjs inspect promocao.wepink.website
node manage.mjs logs promocao.wepink.website
node manage.mjs candidates promocao.wepink.website
node manage.mjs activate promocao.wepink.website observe
node manage.mjs activate promocao.wepink.website enforce
node manage.mjs disable promocao.wepink.website
```

`logs` retorna os últimos 100 registros; o histórico restante continua no D1.
`candidates` agrega no máximo 100 combinações IP/país/motivo dos últimos sete dias;
é uma lista para investigação, não afirmação de que esses IPs são bots.

Exemplo de bloqueio revisado por 24 horas (IP reservado de documentação):

```sh
node manage.mjs block promocao.wepink.website 192.0.2.10 24 "Abuso confirmado em revisão"
node manage.mjs unblock promocao.wepink.website 192.0.2.10
```

Para novo domínio: `inspect HOST`, conferir origem/DNS e então `activate HOST observe`.
O comando recusa sobreposição com rotas de outros Workers ou custom domains existentes.
`disable HOST` mantém a rota e libera a origem, sem apagar o histórico.
`deploy` atualiza apenas este Worker e preserva tabelas/regras. Sem estado local, recusa
sobrescrever um Worker com o mesmo nome. Não executa migrações destrutivas.

## Mapa de impacto

- Leitura: configuração e regras D1; metadados da requisição; consultas privadas.
- Escrita: eventos, configuração por domínio e regras temporárias de IP.
- Exibição: respostas 403/429 genéricas, saúde sem dados pessoais, CLI privada.
- Decisão: regras revisadas, arquivos privados e limite de navegação.
- Efeitos colaterais: um Worker novo e uma rota no domínio autorizado.
- Persistência paralela: D1 e fallback operacional em Workers Logs; sem mudanças
  em Redis, PostgreSQL, RabbitMQ ou nos contadores do Cerberus existente.
- Testes: nove testes automatizados aprovados; três verificações HTTP remotas e
  confirmação da gravação no D1. Não foi feito teste de carga.
- Documentação: este arquivo, schema e código desta pasta. Outros serviços intactos.
