# Hospital Pro

Sistema de gestão hospitalar (atendimento, triagem com classificação de risco,
painel médico, TV de chamadas, almoxarifado e administração), com backend em
Node.js/Express e frontend em HTML/CSS/JavaScript puro.

## Como rodar

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # com recarregamento automático (node --watch)
npm test           # testes automatizados (node --test)
```

Requisito: Node.js 18 ou superior.

## Acessos padrão

Criados automaticamente quando o usuário ainda não existe no banco:

| Usuário        | Senha             | Tela                         |
| -------------- | ----------------- | ---------------------------- |
| `admin`        | `admin123`        | admin.html                   |
| `atendimento`  | `atendimento123`  | atendimento.html             |
| `triagem`      | `triagem123`      | triagem.html                 |
| `medico`       | `medico123`       | medico.html / medicacoes.html|
| `almoxarifado` | `almoxarifado123` | almoxarifado.html            |

**Troque essas senhas na tela de administração** antes de usar o sistema de verdade.
O administrador pode cadastrar novos usuários por setor.

## Fluxo do paciente

1. **Atendimento** cadastra o paciente (nome, CPF, convênio/particular).
2. **Triagem** registra sintoma, temperatura, alergia e observação — o sistema
   classifica o risco em **verde / amarelo / vermelho**.
3. A **triagem** chama o próximo paciente; a **TV** mostra o nome chamado
   (a tela da TV não exige login, pode ficar na sala de espera).
4. O **médico** vê os pacientes chamados, registra diagnóstico e medicação,
   e o estoque é descontado automaticamente.
5. **Medicações** mostra o histórico das consultas.
6. **Almoxarifado** cadastra medicamentos, repõe o estoque e mostra o histórico
   de entradas.

## Fluxo de atendimento e alta

Cada paciente tem uma **situação**, que muda conforme ele anda pelo hospital:

| Situação | Onde aparece |
| --- | --- |
| Aguardando triagem | Atendimento (fila) e Triagem |
| Aguardando chamada | Triagem |
| Chamado para a sala médica | Triagem ("já chamados"), TV e Médico |
| Internado (observação) | Médico, Triagem e Atendimento |
| Alta / Óbito / Evasão / Transferido | Atendimentos concluídos |

**Quem já saiu não fica mais na lista de pacientes no hospital.** Ao registrar
alta (ou óbito, evasão, transferência), o paciente:

- sai da fila e das listas de pacientes ativos;
- tem o atendimento gravado em **Atendimentos concluídos**
  (`atendimentos.html`), com entrada, saída, desfecho, diagnóstico e o
  responsável pelo registro;
- pode ser cadastrado novamente depois (novo atendimento, novo histórico).

**Quem ficou internado continua no sistema**, na lista de internados, até o
médico dar alta.

### Como dar alta

- **Médico**: no fim da consulta, escolha o desfecho (alta, internação,
  transferência, evasão ou óbito) e salve. Para pacientes internados, use o
  botão **✅ Dar alta** na lista de internados.
- **Recepção (atendimento)**: na lista de pacientes, clique em **✅ Alta**.
  Ela não pode registrar internação nem óbito — isso é do médico.
- **Excluir cadastro**: só para pacientes que já saíram do fluxo; o histórico
  do atendimento continua guardado.

Regras que o servidor aplica:

- o mesmo CPF não pode ter dois atendimentos ativos ao mesmo tempo;
- não dá para dar alta duas vezes no mesmo paciente;
- cada desfecho tem setores autorizados (recepção não registra óbito);
- toda alta/desfecho fica registrado com data, hora e quem registrou.

## O que foi melhorado

### Segurança e permissões

- **Login com sessão**: o `/login` devolve um token; as telas guardam o token e
  enviam em `Authorization: Bearer <token>`. Sessão expira em 8 horas
  (`/sessao` confere, `/logout` encerra).
- **Todas as rotas de dados exigem sessão.** Antes, qualquer pessoa na rede
  lia pacientes, triagens e estoque sem login.
- **Permissão por setor** (`PERMISSOES` no backend): por exemplo, só o
  almoxarifado cadastra medicamentos, só o médico registra consultas, só o
  admin cadastra usuários. Tentativa fora do setor recebe 403.
- **Proteção contra força bruta**: após 5 tentativas erradas o usuário fica
  bloqueado por 5 minutos.
- **Senhas com hash scrypt** (já existia) e agora com exigência de mínimo de
  6 caracteres ao cadastrar.
- A tela da TV (`/tv/chamada`) segue pública de propósito, para o monitor da
  recepção — e agora só mostra o primeiro nome na fila.

### Regras de negócio

- **Classificação de risco corrigida**: antes só a temperatura contava, então
  um infarto a 36,5 °C saía como "verde". Agora o risco é o mais grave entre o
  sintoma e a temperatura (infarto/AVC/convulsão/hemorragia/falta de ar grave
  são sempre vermelhos; febre ≥ 38 °C é amarelo e ≥ 39 °C vermelho).
- **Fila ordenada por gravidade** (vermelho primeiro, depois por ordem de
  chegada) na triagem e na TV.
- **CPF validado** com 11 dígitos; continua não sendo exposto nas listagens.
- **Campos livres com limite de tamanho** e nomes normalizados (evita registros
  gigantes no `db.json`).
- **Histórico da TV** mostra só chamadas realmente concluídas.
- **Alta e desfechos**: pacientes atendidos saem da lista de ativos e vão para
  o histórico de atendimentos (`/atendimentos`), em vez de ficarem misturados
  com quem ainda está no hospital.
- **Filtros por situação** na recepção (no hospital, internados, alta,
  encerrados, todos) e por desfecho no histórico.
- **Histórico de consultas** vem do mais recente para o mais antigo e registra
  qual médico fez a consulta.
- Erros de JSON malformado agora respondem 400 (antes viravam 500).

### Frontend

- Novo `frontend/js/api.js`: centraliza token, requisições, proteção de cada
  tela por setor, botão **Sair** e volta ao login quando a sessão expira.
- Todas as telas usam essa camada; não há mais `fetch` solto nas páginas.
- **`atendimento.html` estava com o conteúdo do almoxarifado** (o estoque
  aparece em Agendamento, e a recepção não tem permissão para o estoque).
  A tela foi reescrita: cadastro de paciente + lista de pacientes com a
  situação de cada um no fluxo.

### Testes

`npm test` cobre login, token inválido, logout, permissões por setor, cadastro
de usuário pelo admin, o fluxo completo (estoque → atendimento → triagem →
chamada → consulta → reposição), a classificação de risco e a ordenação da
fila. Cada execução usa um banco temporário: o `backend/db.json` real não é
tocado.

## Estrutura

```
backend/server.js     API + regras de negócio (Express)
backend/db.json       banco de dados em arquivo JSON
frontend/js/api.js    sessão, requisições e proteção das telas
frontend/*.html       telas do sistema
frontend/css/         estilos
tests/server.test.js  testes automatizados
```

## Próximos passos sugeridos

- Trocar o `db.json` por um banco de verdade (SQLite/Postgres) se o sistema
  for usado por vários setores ao mesmo tempo.
- Usar HTTPS e um proxy reverso ao publicar fora da rede local.
- Levar as sessões para o banco, para não derrubar os logins ao reiniciar.
