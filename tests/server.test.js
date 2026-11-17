const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hospital-system-test-"));
const databaseFile = path.join(testDirectory, "db.json");

fs.writeFileSync(databaseFile, JSON.stringify({
  usuarios: [
    { usuario: "admin", senha: "admin123", tipo: "admin" },
    { usuario: "legado", senha: "123456", tipo: "medico" },
    { usuario: "recepcao", senha: "recepcao123", tipo: "atendimento" },
    { usuario: "triagem", senha: "triagem123", tipo: "triagem" },
    { usuario: "almox", senha: "almox123", tipo: "almoxarifado" }
  ],
  pacientes: [],
  triagens: [],
  consultas: [],
  chamadasTv: [],
  estoque: [
    { id: 1, nome: "Dipirona", quantidade: 50, unidade: "cx", categoria: "Analgesico" },
    { id: 2, nome: "Paracetamol", quantidade: 50, unidade: "cx", categoria: "Analgesico" }
  ],
  historicoEntradas: []
}));
process.env.HOSPITAL_DB_FILE = databaseFile;

const app = require("../backend/server");

let server;
let baseUrl;
let tokens = {};

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  tokens = {
    admin: await entrar("admin", "admin123"),
    atendimento: await entrar("recepcao", "recepcao123"),
    triagem: await entrar("triagem", "triagem123"),
    medico: await entrar("legado", "123456"),
    almoxarifado: await entrar("almox", "almox123")
  };
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close(erro => erro ? reject(erro) : resolve());
    });
  }
  fs.rmSync(testDirectory, { recursive: true, force: true });
  delete process.env.HOSPITAL_DB_FILE;
});

async function requisicao(route, dados, metodo = "GET", token) {
  return fetch(`${baseUrl}${route}`, {
    method: dados ? "POST" : metodo,
    headers: {
      ...(dados ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(dados ? { body: JSON.stringify(dados) } : {})
  });
}

async function post(route, dados, token) {
  return requisicao(route, dados, "POST", token);
}

async function get(route, token) {
  return requisicao(route, null, "GET", token);
}

async function encerrar(usuario, senha) {
  const token = await entrar(usuario, senha);
  const resposta = await post("/logout", {}, token);
  assert.equal(resposta.status, 200);
}

async function entrar(usuario, senha) {
  const resposta = await post("/login", { usuario, senha });
  assert.equal(resposta.status, 200);
  const dados = await resposta.json();
  assert.equal(typeof dados.token, "string");
  return dados.token;
}

test("cadastro, triagem, chamada, consulta e persistência", async () => {
  let resposta = await get("/pacientes");
  assert.equal(resposta.status, 401);

  resposta = await post("/usuarios", {
    usuario: "novo",
    senha: "senha-segura",
    tipo: "triagem"
  }, tokens.admin);
  assert.equal(resposta.status, 201);

  resposta = await post("/usuarios", {
    usuario: "NOVO",
    senha: "outra-senha",
    tipo: "medico"
  }, tokens.admin);
  assert.equal(resposta.status, 409);

  resposta = await get("/usuarios", tokens.admin);
  const usuarios = await resposta.json();
  assert.equal(resposta.status, 200);
  assert.equal(usuarios.some(usuario => Object.hasOwn(usuario, "senha")), false);
  assert.equal(usuarios.some(usuario => Object.hasOwn(usuario, "senhaHash")), false);

  // Outro setor não pode mexer na lista de usuários
  resposta = await get("/almoxarifado/estoque", tokens.medico);
  assert.equal(resposta.status, 200);

  resposta = await get("/almoxarifado/estoque", tokens.triagem);
  assert.equal(resposta.status, 403);

  const pacientes = [];
  for (const [indice, nome] of ["Paciente Um", "Paciente Dois"].entries()) {
    resposta = await post("/atendimento", {
      nome,
      cpf: `9876543210${indice}`,
      tipo: "Particular"
    }, tokens.atendimento);
    assert.equal(resposta.status, 201);
    pacientes.push((await resposta.json()).paciente);
  }

  resposta = await get("/pacientes", tokens.triagem);
  const pacientesListados = await resposta.json();
  assert.equal(pacientesListados.length, 2);
  assert.equal(pacientesListados.some(paciente => Object.hasOwn(paciente, "cpf")), false);

  const triagens = [];
  for (const paciente of pacientes) {
    resposta = await post("/triagem", {
      pacienteId: paciente.id,
      sintoma: "febre",
      temperatura: null,
      alergia: "",
      observacao: ""
    }, tokens.triagem);
    assert.equal(resposta.status, 201);
    const { triagem } = await resposta.json();
    assert.equal(triagem.nome, paciente.nome);
    assert.equal(triagem.risco, "amarelo");
    triagens.push(triagem);
  }

  // A TV é pública (fica na sala de espera): funciona sem token
  await encerrar("triagem", "triagem123");
  await encerrar("legado", "123456");
  await encerrar("recepcao", "recepcao123");
  await encerrar("admin", "admin123");
  await encerrar("almox", "almox123");

  resposta = await get("/tv/chamada");
  assert.equal(resposta.status, 200);
  let tv = await resposta.json();
  assert.equal(tv.fila.length, 2);
  assert.equal(tv.chamada, null);

  // E as rotas de dados continuam fechadas sem sessão
  resposta = await get("/pacientes");
  assert.equal(resposta.status, 401);

  tokens.triagem = await entrar("triagem", "triagem123");
  tokens.medico = await entrar("legado", "123456");

  resposta = await post("/consulta", {
    triagemId: triagens[0].id,
    diagnostico: "Avaliação",
    medicacao: "Dipirona"
  }, tokens.medico);
  assert.equal(resposta.status, 409);

  resposta = await post("/tv/chamar", { triagemId: triagens[0].id }, tokens.triagem);
  assert.equal(resposta.status, 200);
  assert.equal((await resposta.json()).chamada.paciente, "Paciente Um");

  resposta = await post("/tv/chamar", { triagemId: triagens[1].id }, tokens.triagem);
  assert.equal(resposta.status, 409);

  resposta = await post("/consulta", {
    triagemId: triagens[0].id,
    diagnostico: "Avaliação",
    medicacao: "Dipirona"
  }, tokens.medico);
  assert.equal(resposta.status, 201);

  resposta = await post("/tv/chamar", { triagemId: triagens[1].id }, tokens.triagem);
  assert.equal(resposta.status, 200);
  resposta = await post("/consulta", {
    triagemId: triagens[1].id,
    diagnostico: "Avaliação",
    medicacao: "Paracetamol"
  }, tokens.medico);
  assert.equal(resposta.status, 201);

  resposta = await get("/tv/chamada");
  tv = await resposta.json();
  assert.equal(tv.chamada, null);
  assert.equal(tv.historico.length, 2);
  assert.deepEqual(tv.fila, []);

  // Com alta registrada, o paciente sai da lista de ativos
  resposta = await get("/pacientes?situacao=ativos", tokens.medico);
  const pacientesAtivos = await resposta.json();
  assert.deepEqual(pacientesAtivos, []);

  resposta = await get("/pacientes?situacao=alta", tokens.medico);
  const pacientesComAlta = await resposta.json();
  assert.equal(pacientesComAlta.length, 2);

  // O histórico guarda o atendimento concluído
  resposta = await get("/atendimentos", tokens.medico);
  const atendimentos = await resposta.json();
  assert.equal(atendimentos.length, 2);
  assert.equal(atendimentos.every(item => item.desfecho === "alta"), true);
  assert.equal(atendimentos.every(item => typeof item.saidaEm === "string"), true);

  const bancoSalvo = JSON.parse(fs.readFileSync(databaseFile, "utf8"));
  assert.equal(bancoSalvo.consultas.length, 2);
  assert.equal(bancoSalvo.usuarios.find(usuario => usuario.usuario === "legado").senha, undefined);
  assert.equal(typeof bancoSalvo.usuarios.find(usuario => usuario.usuario === "legado").senhaHash, "string");
  assert.equal(typeof bancoSalvo.usuarios.find(usuario => usuario.usuario === "novo").senhaHash, "string");
});

test("classifica corretamente as faixas de temperatura na triagem", async () => {
  const casos = [
    { temperatura: 37.9, risco: "verde" },
    { temperatura: 38, risco: "amarelo" },
    { temperatura: 38.9, risco: "amarelo" },
    { temperatura: 39, risco: "vermelho" }
  ];

  for (const [indice, caso] of casos.entries()) {
    const respostaPaciente = await post("/atendimento", {
      nome: `Paciente ${indice}`,
      cpf: `1111111111${indice}`,
      tipo: "Particular"
    }, tokens.atendimento);
    assert.equal(respostaPaciente.status, 201);
    const { paciente } = await respostaPaciente.json();

    const respostaTriagem = await post("/triagem", {
      pacienteId: paciente.id,
      sintoma: "dor_leve",
      temperatura: caso.temperatura
    }, tokens.triagem);
    assert.equal(respostaTriagem.status, 201);
    assert.equal((await respostaTriagem.json()).triagem.risco, caso.risco);
  }
});

test("sintoma grave classifica risco alto mesmo sem febre", async () => {
  const pacienteResposta = await post("/atendimento", {
    nome: "Paciente Grave",
    cpf: "12345678901",
    tipo: "Particular"
  }, tokens.atendimento);
  assert.equal(pacienteResposta.status, 201);
  const { paciente } = await pacienteResposta.json();

  const triagemResposta = await post("/triagem", {
    pacienteId: paciente.id,
    sintoma: "infarto",
    temperatura: 36.5
  }, tokens.triagem);
  assert.equal(triagemResposta.status, 201);
  assert.equal((await triagemResposta.json()).triagem.risco, "vermelho");
});

test("estoque, almoxarifado e permissões entre setores", async () => {
  let resposta = await post("/almoxarifado/medicamentos", {
    nome: "Ibuprofeno",
    quantidade: 10,
    unidade: "cx",
    categoria: "Analgesico"
  }, tokens.almoxarifado);
  assert.equal(resposta.status, 201);
  const medicamento = (await resposta.json()).medicamento;

  // Setor de atendimento não mexe no estoque
  resposta = await post("/almoxarifado/reposicao", {
    id: medicamento.id,
    quantidade: 5
  }, tokens.atendimento);
  assert.equal(resposta.status, 403);

  resposta = await post("/almoxarifado/reposicao", {
    id: medicamento.id,
    quantidade: 5,
    obs: "Compra"
  }, tokens.almoxarifado);
  assert.equal(resposta.status, 200);
  assert.equal((await resposta.json()).medicamento.quantidade, 15);

  resposta = await get("/almoxarifado/historico", tokens.almoxarifado);
  const historico = await resposta.json();
  assert.equal(Array.isArray(historico), true);
  assert.equal(historico.length >= 1, true);

  resposta = await get("/almoxarifado/estoque", tokens.almoxarifado);
  const estoque = await resposta.json();
  assert.equal(estoque.some(item => item.nome === "Ibuprofeno"), true);
});

test("logout encerra a sessão", async () => {
  const token = await entrar("recepcao", "recepcao123");

  let resposta = await post("/logout", {}, token);
  assert.equal(resposta.status, 200);

  resposta = await get("/pacientes", token);
  assert.equal(resposta.status, 401);
});

// ==================================================
// ALTA, DESFECHOS E HISTÓRICO DE ATENDIMENTOS
// ==================================================

test("alta, internação, exclusão e histórico de atendimentos", async () => {
  // Dois pacientes novos passam pelo fluxo
  const cadastrar = async (nome, cpf) => {
    const resposta = await post("/atendimento", {
      nome,
      cpf,
      tipo: "Particular"
    }, tokens.atendimento);
    assert.equal(resposta.status, 201);
    return (await resposta.json()).paciente;
  };

  const maria = await cadastrar("Maria Alta", "11122233344");
  const joao = await cadastrar("Joao Interna", "55566677788");

  // Mesmo CPF em atendimento não pode ser cadastrado de novo
  let resposta = await post("/atendimento", {
    nome: "Maria Duplicada",
    cpf: "11122233344",
    tipo: "Convenio"
  }, tokens.atendimento);
  assert.equal(resposta.status, 409);

  for (const paciente of [maria, joao]) {
    resposta = await post("/triagem", {
      pacienteId: paciente.id,
      sintoma: "dor_leve",
      temperatura: 36.5
    }, tokens.triagem);
    assert.equal(resposta.status, 201);
  }

  // O paciente internado continua no sistema
  resposta = await get("/triagens", tokens.triagem);
  const triagens = await resposta.json();
  const triagemJoao = triagens.find(t => t.pacienteId === joao.id);

  resposta = await post("/tv/chamar", { triagemId: triagemJoao.id }, tokens.triagem);
  assert.equal(resposta.status, 200);

  resposta = await post("/consulta", {
    triagemId: triagemJoao.id,
    diagnostico: "Observação",
    medicacao: "Dipirona",
    desfecho: "internado"
  }, tokens.medico);
  assert.equal(resposta.status, 201);
  assert.equal((await resposta.json()).paciente.status, "internado");

  resposta = await get("/pacientes?situacao=internado", tokens.medico);
  const internados = await resposta.json();
  assert.equal(internados.some(p => p.id === joao.id), true);

  // Alta pela recepção (sem passar pelo médico)
  resposta = await post("/pacientes/alta", {
    pacienteId: maria.id,
    observacao: "Saiu orientada"
  }, tokens.atendimento);
  assert.equal(resposta.status, 200);
  const alta = await resposta.json();
  assert.equal(alta.paciente.status, "alta");
  assert.equal(alta.atendimento.desfecho, "alta");

  // Não dá para dar alta duas vezes
  resposta = await post("/pacientes/alta", { pacienteId: maria.id }, tokens.atendimento);
  assert.equal(resposta.status, 409);

  // Alta do paciente internado pelo médico
  resposta = await post("/pacientes/desfecho", {
    pacienteId: joao.id,
    desfecho: "alta",
    observacao: "Melhorou"
  }, tokens.medico);
  assert.equal(resposta.status, 200);

  // Nenhum dos dois aparece mais entre os pacientes ativos
  resposta = await get("/pacientes?situacao=ativos", tokens.medico);
  const ativos = await resposta.json();
  assert.equal(ativos.some(p => p.id === maria.id || p.id === joao.id), false);

  // O histórico mostra os dois atendimentos concluídos
  resposta = await get("/atendimentos", tokens.medico);
  const atendimentos = await resposta.json();
  const daMaria = atendimentos.filter(a => a.pacienteId === maria.id);
  const doJoao = atendimentos.filter(a => a.pacienteId === joao.id);

  assert.equal(daMaria.length, 1);
  assert.equal(doJoao.length, 1);
  assert.equal(daMaria[0].desfechoRotulo, "Alta");
  assert.equal(typeof daMaria[0].saidaEm, "string");
  assert.equal(daMaria[0].registradoPor, "recepcao");

  // Filtro por desfecho
  resposta = await get("/atendimentos?desfecho=alta", tokens.medico);
  const altas = await resposta.json();
  assert.equal(altas.every(item => item.desfecho === "alta"), true);
  assert.equal(altas.length >= 2, true);

  // O mesmo CPF pode ser cadastrado de novo depois da alta
  resposta = await post("/atendimento", {
    nome: "Maria Alta",
    cpf: "11122233344",
    tipo: "Particular"
  }, tokens.atendimento);
  assert.equal(resposta.status, 201);
  const mariaDeNovo = (await resposta.json()).paciente;

  // Mas o cadastro antigo não pode ser excluído enquanto o novo está ativo
  resposta = await post("/pacientes/excluir", { pacienteId: mariaDeNovo.id }, tokens.atendimento);
  assert.equal(resposta.status, 409);

  // Exclusão de cadastro já encerrado
  resposta = await post("/pacientes/excluir", { pacienteId: maria.id }, tokens.atendimento);
  assert.equal(resposta.status, 200);

  resposta = await get("/pacientes?situacao=alta", tokens.medico);
  const comAlta = await resposta.json();
  assert.equal(comAlta.some(p => p.id === maria.id), false);

  // Almoxarifado não pode dar alta
  resposta = await post("/pacientes/alta", { pacienteId: mariaDeNovo.id }, tokens.almoxarifado);
  assert.equal(resposta.status, 403);

  // Desfecho inválido é recusado
  resposta = await post("/pacientes/desfecho", {
    pacienteId: mariaDeNovo.id,
    desfecho: "sumiu"
  }, tokens.medico);
  assert.equal(resposta.status, 400);

  // Óbito pelo médico encerra o atendimento
  resposta = await post("/pacientes/desfecho", {
    pacienteId: mariaDeNovo.id,
    desfecho: "obito",
    observacao: "Registrado no prontuário"
  }, tokens.medico);
  assert.equal(resposta.status, 200);
  assert.equal((await resposta.json()).paciente.status, "obito");

  resposta = await get("/atendimentos?desfecho=obito", tokens.medico);
  const obitos = await resposta.json();
  assert.equal(obitos.some(item => item.pacienteId === mariaDeNovo.id), true);
});
