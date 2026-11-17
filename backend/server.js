const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "100kb" }));

// Validar o corpo das requisições
app.use((req, res, next) => {
    if (req.body === undefined) {
        req.body = {};
    }

    if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
    ) {
        return res.status(400).json({
            erro: "O corpo da requisição deve ser um objeto JSON."
        });
    }

    next();
});

// Disponibilizar os arquivos do frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// Página inicial do projeto
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

const DB_FILE =
    process.env.HOSPITAL_DB_FILE || path.join(__dirname, "db.json");

const TIPOS_USUARIO = [
    "admin",
    "atendimento",
    "triagem",
    "medico",
    "almoxarifado"
];

// Usuários criados automaticamente quando o banco ainda não tem nenhum.
// Depois do primeiro login, troque as senhas na tela de administração.
const USUARIOS_PADRAO = [
    { usuario: "admin", senha: "admin123", tipo: "admin" },
    { usuario: "atendimento", senha: "atendimento123", tipo: "atendimento" },
    { usuario: "triagem", senha: "triagem123", tipo: "triagem" },
    { usuario: "medico", senha: "medico123", tipo: "medico" },
    { usuario: "almoxarifado", senha: "almoxarifado123", tipo: "almoxarifado" }
];

// Tempo de vida de uma sessão de login
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// Proteção contra força bruta no login
const MAX_TENTATIVAS_LOGIN = 5;
const JANELA_BLOQUEIO_MS = 5 * 60 * 1000;

const TIPOS_PACIENTE = [
    "Convenio",
    "Particular"
];

// Risco mínimo de cada sintoma. O risco final é o do sintoma mais grave,
// combinado com a temperatura.
const SINTOMAS = [
    "dor_leve",
    "resfriado",
    "coriza",
    "tosse",
    "febre",
    "vomito",
    "diarreia",
    "falta_ar_moderada",
    "falta_ar_grave",
    "infarto",
    "avc",
    "convulsao",
    "hemorragia"
];

const RISCO_POR_SINTOMA = {
    dor_leve: "verde",
    resfriado: "verde",
    coriza: "verde",
    tosse: "verde",
    febre: "amarelo",
    vomito: "amarelo",
    diarreia: "amarelo",
    falta_ar_moderada: "amarelo",
    falta_ar_grave: "vermelho",
    infarto: "vermelho",
    avc: "vermelho",
    convulsao: "vermelho",
    hemorragia: "vermelho"
};

const ORDEM_RISCO = { verde: 0, amarelo: 1, vermelho: 2 };

// ==================================================
// FLUXO DO PACIENTE E DESFECHOS
// ==================================================

// Situação do paciente dentro do hospital
const STATUS_PACIENTE = [
    "triagem",              // cadastrado, aguardando a triagem
    "aguardando_chamada",   // triagem feita, aguardando ser chamado
    "aguardando_medico",    // chamado, na sala médica
    "em_atendimento",       // consulta em andamento
    "internado",            // ficou em observação/internação
    "alta",                 // recebeu alta (sai da lista de ativos)
    "obito",                // foi a óbito
    "evasao",               // saiu sem ser atendido
    "transferido"           // transferido para outro serviço
];

// Situações em que o paciente já saiu do fluxo de atendimento
const STATUS_ENCERRADOS = [
    "alta",
    "obito",
    "evasao",
    "transferido"
];

// Situações em que o paciente ainda está no hospital
const STATUS_ATIVOS = STATUS_PACIENTE.filter(
    status => !STATUS_ENCERRADOS.includes(status)
);

// Desfechos que o médico (ou a recepção) pode registrar
const DESFECHOS = {
    alta: {
        rotulo: "Alta",
        texto: "Alta médica — paciente liberado.",
        setores: ["medico", "atendimento", "admin"]
    },
    internado: {
        rotulo: "Internação",
        texto: "Paciente internado para observação.",
        setores: ["medico", "admin"]
    },
    obito: {
        rotulo: "Óbito",
        texto: "Paciente foi a óbito.",
        setores: ["medico", "admin"]
    },
    evasao: {
        rotulo: "Evasão",
        texto: "Paciente saiu sem ser atendido.",
        setores: ["medico", "atendimento", "admin"]
    },
    transferido: {
        rotulo: "Transferência",
        texto: "Paciente transferido para outro serviço.",
        setores: ["medico", "atendimento", "admin"]
    }
};

// Setores autorizados em cada rota. O admin tem acesso a tudo e as rotas
// que não aparecem aqui exigem apenas uma sessão válida.
const PERMISSOES = {
    "/usuarios": ["admin"],
    "/atendimento": ["atendimento", "admin"],
    "/pacientes": ["atendimento", "triagem", "medico", "admin"],
    "/triagem": ["triagem", "admin"],
    "/triagens": ["triagem", "medico", "admin"],
    "/tv/chamar": ["triagem", "admin"],
    "/tv/atender": ["medico", "admin"],
    "/lista-medicacoes": ["medico", "admin"],
    "/consulta": ["medico", "admin"],
    "/medicacoes": ["medico", "almoxarifado", "admin"],
    "/almoxarifado/estoque": ["medico", "almoxarifado", "admin"],
    "/almoxarifado/medicamentos": ["almoxarifado", "admin"],
    "/almoxarifado/reposicao": ["almoxarifado", "admin"],
    "/almoxarifado/historico": ["almoxarifado", "admin"],
    "/pacientes/permanencia": ["atendimento", "triagem", "medico", "admin"],
    "/pacientes/excluir": ["atendimento", "admin"],
    "/atendimentos": ["medico", "atendimento", "admin"]
};

// Criar a estrutura inicial do banco
function criarBancoVazio() {
    return {
        usuarios: [],
        pacientes: [],
        triagens: [],
        consultas: [],
        atendimentos: [],
        chamadasTv: [],
        estoque: [],
        historicoEntradas: []
    };
}

// Ler o banco de dados
function adicionarUsuariosPadrao(banco) {
    const usuariosExistentes = new Set(
        banco.usuarios
            .map(usuario => String(usuario.usuario).toLowerCase())
    );

    for (const usuarioPadrao of USUARIOS_PADRAO) {
        if (!usuariosExistentes.has(usuarioPadrao.usuario.toLowerCase())) {
            banco.usuarios.push({
                id: proximoId(banco.usuarios),
                usuario: usuarioPadrao.usuario,
                ...criarSenha(usuarioPadrao.senha),
                tipo: usuarioPadrao.tipo
            });
            usuariosExistentes.add(usuarioPadrao.usuario.toLowerCase());
        }
    }

    return banco;
}

function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        return adicionarUsuariosPadrao(criarBancoVazio());
    }

    const conteudo = fs.readFileSync(DB_FILE, "utf8");
    const db = JSON.parse(conteudo);
    const banco = criarBancoVazio();

    for (const chave of Object.keys(banco)) {
        banco[chave] = Array.isArray(db[chave])
            ? db[chave]
            : [];
    }

    // Usuários padrão entram só em memória aqui; o arquivo é gravado
    // quando o próprio login migra a senha para hash.
    return adicionarUsuariosPadrao(banco);
}

// Salvar o banco de dados
function writeDB(data) {
    const pasta = path.dirname(DB_FILE);

    if (!fs.existsSync(pasta)) {
        fs.mkdirSync(pasta, { recursive: true });
    }

    const arquivoTemporario =
        `${DB_FILE}.${process.pid}.tmp`;

    try {
        fs.writeFileSync(
            arquivoTemporario,
            JSON.stringify(data, null, 2),
            "utf8"
        );

        fs.renameSync(arquivoTemporario, DB_FILE);
    } catch (erro) {
        if (fs.existsSync(arquivoTemporario)) {
            fs.unlinkSync(arquivoTemporario);
        }

        throw erro;
    }
}

// Texto limpo, sem espaços nas pontas e com tamanho máximo
function texto(valor, maximo = 500) {
    return typeof valor === "string"
        ? valor.trim().slice(0, maximo)
        : "";
}

// Inteiro positivo ou null
function inteiroPositivo(valor) {
    const numero = Number(valor);

    return Number.isSafeInteger(numero) && numero > 0
        ? numero
        : null;
}

// Gerar identificadores
function proximoId(registros) {
    const maiorId = registros.reduce(
        (maior, registro) =>
            Number.isSafeInteger(registro.id)
                ? Math.max(maior, registro.id)
                : maior,
        0
    );

    return Math.max(Date.now(), maiorId + 1);
}

function riscoMaximo(...riscos) {
    return riscos.reduce(
        (maior, risco) =>
            ORDEM_RISCO[risco] > ORDEM_RISCO[maior] ? risco : maior,
        "verde"
    );
}

// Classificar risco combinando o sintoma mais grave e a temperatura
function classificarRisco(sintoma, temperatura) {
    let risco = RISCO_POR_SINTOMA[sintoma] || "verde";

    if (typeof temperatura === "number" && Number.isFinite(temperatura)) {
        if (temperatura >= 39) {
            risco = riscoMaximo(risco, "vermelho");
        } else if (temperatura >= 38) {
            risco = riscoMaximo(risco, "amarelo");
        }
    }

    return risco;
}

// Casos mais graves primeiro, depois ordem de chegada
function ordenarPorRisco(lista) {
    return lista.slice().sort(
        (a, b) =>
            ORDEM_RISCO[b.risco] - ORDEM_RISCO[a.risco] ||
            String(a.createdAt).localeCompare(String(b.createdAt))
    );
}

// Criar hash de senha
function criarSenha(senha) {
    const salt = crypto.randomBytes(16).toString("hex");

    const senhaHash = crypto
        .scryptSync(senha, salt, 64)
        .toString("hex");

    return {
        senhaSalt: salt,
        senhaHash
    };
}

// Validar senha, aceitando senhas antigas em texto simples
function validarSenha(usuario, senha) {
    if (
        typeof usuario.senhaHash === "string" &&
        /^[a-f0-9]{128}$/i.test(usuario.senhaHash) &&
        typeof usuario.senhaSalt === "string" &&
        /^[a-f0-9]{32}$/i.test(usuario.senhaSalt)
    ) {
        const hashArmazenado = Buffer.from(
            usuario.senhaHash,
            "hex"
        );

        const hashInformado = crypto.scryptSync(
            senha,
            usuario.senhaSalt,
            hashArmazenado.length
        );

        return crypto.timingSafeEqual(
            hashArmazenado,
            hashInformado
        );
    }

    return (
        typeof usuario.senha === "string" &&
        usuario.senha === senha
    );
}

// ==================================================
// SESSÕES
// ==================================================

// As sessões ficam em memória: reiniciar o servidor derruba os logins.
const sessoes = new Map();

function hashToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

function limparSessoesExpiradas() {
    const agora = Date.now();

    for (const [chave, sessao] of sessoes) {
        if (sessao.expiraEm <= agora) {
            sessoes.delete(chave);
        }
    }
}

function criarSessao(usuario) {
    const token = crypto.randomBytes(32).toString("hex");

    sessoes.set(hashToken(token), {
        usuario: usuario.usuario,
        tipo: usuario.tipo,
        expiraEm: Date.now() + SESSION_TTL_MS
    });

    limparSessoesExpiradas();

    return token;
}

function encerrarSessao(token) {
    if (token) {
        sessoes.delete(hashToken(token));
    }
}

// Token enviado pelo frontend em "Authorization: Bearer <token>"
function lerToken(req) {
    const cabecalho = req.headers.authorization;

    if (
        typeof cabecalho === "string" &&
        cabecalho.startsWith("Bearer ")
    ) {
        return cabecalho.slice(7).trim();
    }

    return null;
}

function autenticar(req, res, next) {
    if (req.path === "/saude" || (req.path === "/tv/chamada" && req.method === "GET")) {
        return next();
    }

    const token = lerToken(req);
    const sessao = token ? sessoes.get(hashToken(token)) : null;

    if (!sessao || sessao.expiraEm <= Date.now()) {
        if (token) {
            encerrarSessao(token);
        }

        return res.status(401).json({
            erro: "Sessão expirada ou inexistente. Faça login novamente."
        });
    }

    req.usuario = {
        usuario: sessao.usuario,
        tipo: sessao.tipo
    };

    next();
}

function exigirPermissaoDaRota(req, res, next) {
    const setores = PERMISSOES[req.path];

    if (
        Array.isArray(setores) &&
        !setores.includes(req.usuario.tipo)
    ) {
        return res.status(403).json({
            erro: "Seu setor não tem permissão para esta operação."
        });
    }

    next();
}

// ==================================================
// HELPERS DO FLUXO DE ATENDIMENTO
// ==================================================

function pacientePorId(db, pacienteId) {
    return db.pacientes.find(item => item.id === pacienteId) || null;
}

// Última triagem registrada para um paciente
function triagemDoPaciente(db, pacienteId) {
    return (
        db.triagens
            .filter(item => item.pacienteId === pacienteId)
            .sort(
                (a, b) =>
                    String(b.createdAt).localeCompare(String(a.createdAt))
            )[0] || null
    );
}

// Atendimento (passagem do paciente pelo hospital) ainda em aberto
function atendimentoAberto(db, pacienteId) {
    return (
        db.atendimentos.find(
            item => item.pacienteId === pacienteId && !item.saidaEm
        ) || null
    );
}

// Mantém o paciente e a triagem atual com a mesma situação
function definirStatus(db, paciente, status) {
    paciente.status = status;
    paciente.statusEm = new Date().toISOString();

    const triagem = triagemDoPaciente(db, paciente.id);

    if (triagem && !STATUS_ENCERRADOS.includes(status)) {
        triagem.status = status;
    }

    return triagem;
}

function resumoPaciente(paciente) {
    return {
        id: paciente.id,
        nome: paciente.nome,
        tipo: paciente.tipo,
        status: paciente.status,
        statusEm: paciente.statusEm || paciente.createdAt,
        createdAt: paciente.createdAt,
        atendimentoId: paciente.atendimentoId || null
    };
}

// Registrar a saída do paciente do fluxo (alta, óbito, evasão, transferência)
function encerrarAtendimento(db, paciente, desfecho, detalhes = {}) {
    const agora = new Date().toISOString();

    const config = DESFECHOS[desfecho];

    if (!config) {
        return null;
    }

    const atendimento =
        atendimentoAberto(db, paciente.id) ||
        db.atendimentos
            .filter(item => item.pacienteId === paciente.id)
            .sort(
                (a, b) =>
                    String(b.entradaEm).localeCompare(String(a.entradaEm))
            )[0] ||
        null;

    const registro = {
        id: proximoId(db.atendimentos),
        pacienteId: paciente.id,
        nome: paciente.nome,
        cpf: paciente.cpf,
        tipo: paciente.tipo,
        triagemId: detalhes.triagemId || null,
        risco: detalhes.risco || null,
        sintoma: detalhes.sintoma || null,
        diagnostico: detalhes.diagnostico || "",
        medicacao: detalhes.medicacao || "",
        obs: detalhes.obs || "",
        medico: detalhes.medico || null,
        desfecho,
        desfechoRotulo: config.rotulo,
        resumo: detalhes.resumo || config.texto,
        entradaEm: atendimento ? atendimento.entradaEm : paciente.createdAt,
        saidaEm: agora,
        registradoPor: detalhes.registradoPor || null
    };

    // Remove o atendimento em aberto e guarda o concluído
    if (atendimento) {
        db.atendimentos = db.atendimentos.filter(
            item => item.id !== atendimento.id
        );
    }

    db.atendimentos.unshift(registro);
    db.atendimentos = db.atendimentos.slice(0, 500);

    definirStatus(db, paciente, desfecho);
    paciente.desfecho = desfecho;
    paciente.saidaEm = agora;
    paciente.atendimentoId = null;

    // Fecha chamadas da TV que ainda estavam abertas para este paciente
    db.chamadasTv.forEach(chamada => {
        if (
            chamada.pacienteId === paciente.id &&
            chamada.status === "aguardando"
        ) {
            chamada.status = "atendida";
            chamada.atendidaEm = agora;
        }
    });

    return registro;
}

// ==================================================
// USUÁRIOS
// ==================================================

// Listar usuários sem mostrar as senhas
app.get("/usuarios", (req, res) => {
    const db = readDB();

    res.json(
        db.usuarios.map(({ usuario, tipo }) => ({
            usuario,
            tipo
        }))
    );
});

// Cadastrar usuário
app.post("/usuarios", (req, res) => {
    const usuario =
        typeof req.body.usuario === "string"
            ? req.body.usuario.trim()
            : "";

    const senha =
        typeof req.body.senha === "string"
            ? req.body.senha
            : "";

    const tipo = req.body.tipo;

    if (
        !usuario ||
        !senha.trim() ||
        !TIPOS_USUARIO.includes(tipo)
    ) {
        return res.status(400).json({
            erro: "Informe usuário, senha e um setor válido."
        });
    }

    if (senha.length < 6) {
        return res.status(400).json({
            erro: "A senha deve ter no mínimo 6 caracteres."
        });
    }

    const db = readDB();

    const existe = db.usuarios.some(
        item =>
            item.usuario.toLowerCase() ===
            usuario.toLowerCase()
    );

    if (existe) {
        return res.status(409).json({
            erro: "Este nome de usuário já está cadastrado."
        });
    }

    const novoUsuario = {
        id: proximoId(db.usuarios),
        usuario,
        ...criarSenha(senha),
        tipo
    };

    db.usuarios.push(novoUsuario);
    writeDB(db);

    res.status(201).json({
        mensagem: "Usuário cadastrado com sucesso.",
        usuario: novoUsuario.usuario,
        tipo: novoUsuario.tipo
    });
});

// Verificação rápida de que o servidor está no ar
app.get("/saude", (req, res) => {
    res.json({
        status: "ok",
        horario: new Date().toISOString()
    });
});

// ==================================================
// LOGIN
// ==================================================

// Tentativas de login por usuário, para frear força bruta
const tentativasLogin = new Map();

function loginBloqueado(chave) {
    const registro = tentativasLogin.get(chave);

    if (!registro) {
        return false;
    }

    if (Date.now() - registro.desde > JANELA_BLOQUEIO_MS) {
        tentativasLogin.delete(chave);
        return false;
    }

    return registro.contagem >= MAX_TENTATIVAS_LOGIN;
}

function registrarFalhaLogin(chave) {
    const registro = tentativasLogin.get(chave);

    if (!registro || Date.now() - registro.desde > JANELA_BLOQUEIO_MS) {
        tentativasLogin.set(chave, { contagem: 1, desde: Date.now() });
        return;
    }

    registro.contagem += 1;
}

app.post("/login", (req, res) => {
    const db = readDB();

    const nomeUsuario =
        typeof req.body.usuario === "string"
            ? req.body.usuario.trim()
            : "";

    const senha =
        typeof req.body.senha === "string"
            ? req.body.senha
            : "";

    if (!nomeUsuario || !senha) {
        return res.status(400).json({
            erro: "Informe usuário e senha."
        });
    }

    const chave = nomeUsuario.toLowerCase();

    if (loginBloqueado(chave)) {
        return res.status(429).json({
            erro: "Muitas tentativas. Aguarde alguns minutos e tente novamente."
        });
    }

    const usuario = db.usuarios.find(
        item =>
            item.usuario.toLowerCase() ===
            nomeUsuario.toLowerCase()
    );

    if (!usuario || !validarSenha(usuario, senha)) {
        registrarFalhaLogin(chave);

        return res.status(401).json({
            erro: "Usuário ou senha inválidos."
        });
    }

    tentativasLogin.delete(chave);

    // Atualizar senhas antigas para hash
    if (typeof usuario.senhaHash !== "string") {
        Object.assign(usuario, criarSenha(senha));
        delete usuario.senha;

        writeDB(db);
    }

    const token = criarSessao(usuario);

    res.json({
        mensagem: "Login realizado com sucesso.",
        usuario: usuario.usuario,
        tipo: usuario.tipo,
        token,
        expiraEm: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    });
});

// ==================================================
// A PARTIR DAQUI TUDO EXIGE SESSÃO VÁLIDA
// ==================================================

app.use(autenticar);
app.use(exigirPermissaoDaRota);

app.all("/sessao", (req, res) => {
    if (req.method !== "GET") {
        return res.status(405).json({
            erro: "Método não permitido."
        });
    }

    res.json(req.usuario);
});

app.post("/logout", (req, res) => {
    encerrarSessao(lerToken(req));
    res.json({ mensagem: "Logout realizado com sucesso." });
});

// ==================================================
// ATENDIMENTO
// ==================================================

app.post("/atendimento", (req, res) => {
    const nome = texto(req.body.nome, 100);

    const cpf =
        typeof req.body.cpf === "string"
            ? req.body.cpf.replace(/\D/g, "")
            : "";

    const tipo = req.body.tipo;

    if (
        !nome ||
        cpf.length !== 11 ||
        !TIPOS_PACIENTE.includes(tipo)
    ) {
        return res.status(400).json({
            erro: "Informe nome, CPF (11 dígitos) e tipo de atendimento válido."
        });
    }

    const db = readDB();

    // Não permite dois cadastros ativos com o mesmo CPF
    const emAberto = db.pacientes.find(
        item =>
            item.cpf === cpf &&
            !STATUS_ENCERRADOS.includes(item.status)
    );

    if (emAberto) {
        return res.status(409).json({
            erro: `Este CPF já está em atendimento (${emAberto.nome}). ` +
                "Dê alta ou encerre o atendimento anterior antes de cadastrar de novo."
        });
    }

    const agora = new Date().toISOString();

    const paciente = {
        id: proximoId(db.pacientes),
        nome,
        cpf,
        tipo,
        status: "triagem",
        statusEm: agora,
        createdAt: agora
    };

    // Abre a passagem do paciente pelo hospital
    const atendimento = {
        id: proximoId(db.atendimentos),
        pacienteId: paciente.id,
        nome,
        cpf,
        tipo,
        entradaEm: agora,
        registradoPor: req.usuario.usuario
    };

    paciente.atendimentoId = atendimento.id;

    db.pacientes.push(paciente);
    db.atendimentos.unshift(atendimento);
    writeDB(db);

    res.status(201).json({
        mensagem: "Paciente cadastrado e encaminhado para triagem.",
        paciente: resumoPaciente(paciente)
    });
});

// Listar pacientes sem expor o CPF
app.get("/pacientes", (req, res) => {
    const db = readDB();

    // ?situacao=ativos | encerrados | alta | internado ...
    const situacao = texto(req.query.situacao, 30).toLowerCase();

    let lista = db.pacientes;

    if (situacao === "ativos") {
        lista = lista.filter(
            item => !STATUS_ENCERRADOS.includes(item.status)
        );
    } else if (situacao === "encerrados") {
        lista = lista.filter(
            item => STATUS_ENCERRADOS.includes(item.status)
        );
    } else if (STATUS_PACIENTE.includes(situacao)) {
        lista = lista.filter(item => item.status === situacao);
    }

    res.json(
        lista
            .slice()
            .sort(
                (a, b) =>
                    String(b.statusEm || b.createdAt).localeCompare(
                        String(a.statusEm || a.createdAt)
                    )
            )
            .map(resumoPaciente)
    );
});

// ==================================================
// TRIAGEM
// ==================================================

app.post("/triagem", (req, res) => {
    const db = readDB();

    const pacienteId = Number(req.body.pacienteId);

    const sintoma =
        typeof req.body.sintoma === "string"
            ? req.body.sintoma
            : "";

    const temperatura =
        req.body.temperatura === null ||
        req.body.temperatura === "" ||
        req.body.temperatura === undefined
            ? null
            : Number(req.body.temperatura);

    if (!Number.isSafeInteger(pacienteId)) {
        return res.status(400).json({
            erro: "Selecione um paciente válido."
        });
    }

    if (!SINTOMAS.includes(sintoma)) {
        return res.status(400).json({
            erro: "Selecione um sintoma válido."
        });
    }

    if (
        temperatura !== null &&
        (
            !Number.isFinite(temperatura) ||
            temperatura < 30 ||
            temperatura > 45
        )
    ) {
        return res.status(400).json({
            erro: "Informe uma temperatura entre 30°C e 45°C."
        });
    }

    const paciente = db.pacientes.find(
        item => item.id === pacienteId
    );

    if (!paciente) {
        return res.status(404).json({
            erro: "Paciente não encontrado."
        });
    }

    if (paciente.status !== "triagem") {
        return res.status(409).json({
            erro: "Este paciente já iniciou ou concluiu a triagem."
        });
    }

    const risco = classificarRisco(
        sintoma,
        temperatura === null ? 0 : temperatura
    );

    const triagem = {
        id: proximoId(db.triagens),
        pacienteId: paciente.id,
        nome: paciente.nome,
        sintoma,
        temperatura,
        alergia: texto(req.body.alergia, 200),
        observacao: texto(req.body.observacao, 500),
        risco,
        status: "aguardando_chamada",
        createdAt: new Date().toISOString()
    };

    db.triagens.push(triagem);
    paciente.status = "aguardando_chamada";

    writeDB(db);

    res.status(201).json({
        mensagem: "Triagem registrada com sucesso.",
        triagem
    });
});

// Listar triagens, começando pelos casos mais graves
app.get("/triagens", (req, res) => {
    const db = readDB();

    res.json(ordenarPorRisco(db.triagens));
});

// ==================================================
// TELA DA TV
// ==================================================

function chamadaEmAberto(db) {
    return (
        db.chamadasTv.find(
            chamada => chamada.status === "aguardando"
        ) || null
    );
}

app.get("/tv/chamada", (req, res) => {
    const db = readDB();

    const fila = ordenarPorRisco(
        db.triagens.filter(
            triagem => triagem.status === "aguardando_chamada"
        )
    ).map(({ id, nome, risco }) => ({
        id,
        nome,
        risco
    }));

    res.json({
        chamada: chamadaEmAberto(db),
        historico: db.chamadasTv
            .filter(chamada => chamada.status === "atendida")
            .slice(0, 4),
        fila
    });
});

// Chamar paciente para a sala médica
app.post("/tv/chamar", (req, res) => {
    const triagemId = Number(req.body.triagemId);

    if (!Number.isSafeInteger(triagemId)) {
        return res.status(400).json({
            erro: "Identificador de triagem inválido."
        });
    }

    const db = readDB();

    const triagem = db.triagens.find(
        item => item.id === triagemId
    );

    if (!triagem) {
        return res.status(404).json({
            erro: "Triagem não encontrada."
        });
    }

    if (triagem.status !== "aguardando_chamada") {
        return res.status(409).json({
            erro: "Este paciente já foi chamado ou atendido."
        });
    }

    if (chamadaEmAberto(db)) {
        return res.status(409).json({
            erro: "Atenda o paciente chamado antes de chamar o próximo."
        });
    }

    const chamada = {
        id: proximoId(db.chamadasTv),
        triagemId: triagem.id,
        pacienteId: triagem.pacienteId,
        paciente: triagem.nome,
        localTipo: "SALA MÉDICA",
        localNumero: "1",
        status: "aguardando",
        createdAt: new Date().toISOString()
    };

    triagem.status = "aguardando_medico";

    const paciente = db.pacientes.find(
        item => item.id === triagem.pacienteId
    );

    if (paciente) {
        paciente.status = "aguardando_medico";
    }

    db.chamadasTv.unshift(chamada);
    db.chamadasTv = db.chamadasTv.slice(0, 20);

    writeDB(db);

    res.json({
        mensagem: "Paciente chamado com sucesso.",
        chamada
    });
});

// Encerrar a chamada em aberto (o paciente entrou na sala)
app.post("/tv/atender", (req, res) => {
    const db = readDB();
    const chamada = chamadaEmAberto(db);

    if (!chamada) {
        return res.status(404).json({
            erro: "Não há chamada em aberto."
        });
    }

    chamada.status = "atendida";
    chamada.atendidaEm = new Date().toISOString();

    writeDB(db);

    res.json({
        mensagem: "Chamada encerrada.",
        chamada
    });
});

// ==================================================
// MEDICAÇÕES
// ==================================================

// Listar medicamentos disponíveis no estoque.
// Mantém o formato antigo: uma lista de nomes.
app.get("/lista-medicacoes", (req, res) => {
    const db = readDB();

    const medicamentosDisponiveis = db.estoque
        .filter(item => item.quantidade > 0)
        .map(item => item.nome);

    res.json(medicamentosDisponiveis);
});

// ==================================================
// CONSULTA MÉDICA
// ==================================================

app.post("/consulta", (req, res) => {
    const db = readDB();

    const triagemId = Number(req.body.triagemId);

    const diagnostico =
        typeof req.body.diagnostico === "string"
            ? req.body.diagnostico.trim()
            : "";

    const medicacao =
        typeof req.body.medicacao === "string"
            ? req.body.medicacao.trim()
            : "";

    const obs =
        typeof req.body.obs === "string"
            ? req.body.obs.trim()
            : "";

    // Desfecho do atendimento: alta (padrão), internação, óbito,
    // evasão ou transferência.
    const desfecho = texto(req.body.desfecho, 20) || "alta";

    if (!Number.isSafeInteger(triagemId)) {
        return res.status(400).json({
            erro: "Identificador de triagem inválido."
        });
    }

    if (!diagnostico || !medicacao) {
        return res.status(400).json({
            erro: "Informe o diagnóstico e selecione uma medicação."
        });
    }

    const configDesfecho = DESFECHOS[desfecho];

    if (!configDesfecho) {
        return res.status(400).json({
            erro: "Desfecho inválido. Use alta, internado, obito, evasao ou transferido."
        });
    }

    if (!configDesfecho.setores.includes(req.usuario.tipo)) {
        return res.status(403).json({
            erro: "Seu setor não pode registrar este desfecho."
        });
    }

    const triagem = db.triagens.find(
        item => item.id === triagemId
    );

    if (!triagem) {
        return res.status(404).json({
            erro: "Triagem não encontrada."
        });
    }

    if (!["aguardando_medico", "em_atendimento", "internado"].includes(triagem.status)) {
        return res.status(409).json({
            erro: "O paciente precisa ser chamado antes da consulta."
        });
    }

    // Localizar medicamento no estoque
    const medicamentoEstoque = db.estoque.find(
        item =>
            item.nome.toLowerCase() === medicacao.toLowerCase()
    );

    if (!medicamentoEstoque) {
        return res.status(404).json({
            erro: "Medicamento não cadastrado no almoxarifado."
        });
    }

    if (
        !Number.isSafeInteger(medicamentoEstoque.quantidade) ||
        medicamentoEstoque.quantidade < 1
    ) {
        return res.status(409).json({
            erro: "Medicamento sem estoque disponível."
        });
    }

    // Registrar consulta
    const consulta = {
        id: proximoId(db.consultas),
        triagemId,
        paciente: triagem.nome,
        diagnostico,
        medicacao: medicamentoEstoque.nome,
        medicacaoId: medicamentoEstoque.id,
        obs,
        medico: req.usuario.usuario,
        createdAt: new Date().toISOString()
    };

    // Descontar uma unidade do estoque
    medicamentoEstoque.quantidade -= 1;

    // Atualizar histórico de consultas
    db.consultas.push(consulta);

    // Finalizar chamada da TV
    const chamadaAtual = db.chamadasTv.find(
        chamada =>
            chamada.triagemId === triagem.id &&
            chamada.status !== "atendida"
    );

    if (chamadaAtual) {
        chamadaAtual.status = "atendida";
        chamadaAtual.atendidaEm = new Date().toISOString();
    }

    const paciente = pacientePorId(db, triagem.pacienteId);

    if (!paciente) {
        return res.status(404).json({
            erro: "Paciente da triagem não encontrado."
        });
    }

    let atendimento = null;

    if (desfecho === "internado") {
        // Fica em observação: continua no sistema, agora internado
        definirStatus(db, paciente, "internado");
        paciente.internadoEm = new Date().toISOString();

        atendimento = atendimentoAberto(db, paciente.id);

        if (atendimento) {
            atendimento.ultimaConsultaId = consulta.id;
        }
    } else {
        // Alta, óbito, evasão ou transferência: sai do fluxo de atendimento
        atendimento = encerrarAtendimento(db, paciente, desfecho, {
            triagemId: triagem.id,
            risco: triagem.risco,
            sintoma: triagem.sintoma,
            diagnostico,
            medicacao: medicamentoEstoque.nome,
            obs,
            medico: req.usuario.usuario,
            registradoPor: req.usuario.usuario
        });
    }

    // Salvar todas as alterações juntas
    writeDB(db);

    res.status(201).json({
        mensagem:
            `Consulta registrada (${configDesfecho.rotulo}) e estoque atualizado.`,
        consulta,
        desfecho,
        atendimento,
        paciente: resumoPaciente(paciente),
        estoqueAtualizado: {
            id: medicamentoEstoque.id,
            nome: medicamentoEstoque.nome,
            quantidade: medicamentoEstoque.quantidade,
            unidade: medicamentoEstoque.unidade
        }
    });
});

// ==================================================
// DESFECHOS, ALTA E HISTÓRICO DE ATENDIMENTOS
// ==================================================

// Registrar a saída do paciente: alta, óbito, evasão ou transferência.
// Também serve para reinternar (desfecho "internado") um paciente ativo.
app.post("/pacientes/desfecho", (req, res) => {
    const db = readDB();

    const pacienteId = Number(req.body.pacienteId);
    const desfecho = texto(req.body.desfecho, 20);
    const observacao = texto(req.body.observacao, 500);

    if (!Number.isSafeInteger(pacienteId)) {
        return res.status(400).json({
            erro: "Selecione um paciente válido."
        });
    }

    const config = DESFECHOS[desfecho];

    if (!config) {
        return res.status(400).json({
            erro: "Desfecho inválido. Use alta, internado, obito, evasao ou transferido."
        });
    }

    if (!config.setores.includes(req.usuario.tipo)) {
        return res.status(403).json({
            erro: "Seu setor não pode registrar este desfecho."
        });
    }

    const paciente = pacientePorId(db, pacienteId);

    if (!paciente) {
        return res.status(404).json({
            erro: "Paciente não encontrado."
        });
    }

    if (STATUS_ENCERRADOS.includes(paciente.status)) {
        return res.status(409).json({
            erro: "Este paciente já recebeu alta/encerramento. " +
                "Cadastre um novo atendimento para ele."
        });
    }

    if (desfecho === "internado") {
        definirStatus(db, paciente, "internado");
        paciente.internadoEm = new Date().toISOString();

        writeDB(db);

        return res.json({
            mensagem: "Paciente internado para observação.",
            paciente: resumoPaciente(paciente)
        });
    }

    const triagem = triagemDoPaciente(db, paciente.id);

    const registro = encerrarAtendimento(db, paciente, desfecho, {
        triagemId: triagem ? triagem.id : null,
        risco: triagem ? triagem.risco : null,
        sintoma: triagem ? triagem.sintoma : null,
        obs: observacao,
        registradoPor: req.usuario.usuario
    });

    writeDB(db);

    res.json({
        mensagem: `${config.rotulo} registrada(o) para ${paciente.nome}.`,
        atendimento: registro,
        paciente: resumoPaciente(paciente)
    });
});

// Alta médica (atalho usado pela recepção e pelo médico)
app.post("/pacientes/alta", (req, res) => {
    req.body = { ...req.body, desfecho: "alta" };

    // Reaproveita a mesma regra da rota de desfecho
    const db = readDB();
    const pacienteId = Number(req.body.pacienteId);
    const observacao = texto(req.body.observacao, 500);

    if (!Number.isSafeInteger(pacienteId)) {
        return res.status(400).json({
            erro: "Selecione um paciente válido."
        });
    }

    if (!DESFECHOS.alta.setores.includes(req.usuario.tipo)) {
        return res.status(403).json({
            erro: "Seu setor não pode dar alta."
        });
    }

    const paciente = pacientePorId(db, pacienteId);

    if (!paciente) {
        return res.status(404).json({
            erro: "Paciente não encontrado."
        });
    }

    if (STATUS_ENCERRADOS.includes(paciente.status)) {
        return res.status(409).json({
            erro: "Este paciente já recebeu alta."
        });
    }

    const triagem = triagemDoPaciente(db, paciente.id);

    const registro = encerrarAtendimento(db, paciente, "alta", {
        triagemId: triagem ? triagem.id : null,
        risco: triagem ? triagem.risco : null,
        sintoma: triagem ? triagem.sintoma : null,
        obs: observacao,
        registradoPor: req.usuario.usuario
    });

    writeDB(db);

    res.json({
        mensagem: `Alta registrada para ${paciente.nome}.`,
        atendimento: registro,
        paciente: resumoPaciente(paciente)
    });
});

// Corrigir o cadastro de um paciente que saiu do sistema.
// O registro não é apagado do histórico: fica marcado como excluído.
app.post("/pacientes/excluir", (req, res) => {
    const db = readDB();

    const pacienteId = Number(req.body.pacienteId);

    if (!Number.isSafeInteger(pacienteId)) {
        return res.status(400).json({
            erro: "Selecione um paciente válido."
        });
    }

    const paciente = pacientePorId(db, pacienteId);

    if (!paciente) {
        return res.status(404).json({
            erro: "Paciente não encontrado."
        });
    }

    if (!STATUS_ENCERRADOS.includes(paciente.status)) {
        return res.status(409).json({
            erro: "Só é possível excluir cadastros de pacientes que já " +
                "receberam alta ou tiveram o atendimento encerrado."
        });
    }

    const indice = db.pacientes.findIndex(item => item.id === paciente.id);

    db.pacientes.splice(indice, 1);

    const atendimento = atendimentoAberto(db, paciente.id);

    if (atendimento) {
        db.atendimentos = db.atendimentos.filter(
            item => item.id !== atendimento.id
        );
    }

    writeDB(db);

    res.json({
        mensagem: `Cadastro de ${paciente.nome} removido da lista.`,
        pacienteId: paciente.id
    });
});

// Histórico de atendimentos concluídos (quem já recebeu alta, foi
// internado, teve óbito, evasão ou transferência).
app.get("/atendimentos", (req, res) => {
    const db = readDB();

    const desfecho = texto(req.query.desfecho, 20).toLowerCase();
    const termo = texto(req.query.busca, 100).toLowerCase();

    let lista = db.atendimentos;

    if (DESFECHOS[desfecho]) {
        lista = lista.filter(item => item.desfecho === desfecho);
    }

    if (termo) {
        lista = lista.filter(
            item =>
                String(item.nome).toLowerCase().includes(termo) ||
                String(item.cpf).includes(termo)
        );
    }

    res.json(lista);
});

// ==================================================
// HISTÓRICO DE MEDICAÇÕES E CONSULTAS
// ==================================================

app.get("/medicacoes", (req, res) => {
    const db = readDB();

    res.json(db.consultas.slice().reverse());
});

// ==================================================
// ALMOXARIFADO
// ==================================================

// Consultar todos os medicamentos do estoque
app.get("/almoxarifado/estoque", (req, res) => {
    const db = readDB();

    res.json(db.estoque);
});

// Cadastrar novo medicamento
app.post("/almoxarifado/medicamentos", (req, res) => {
    const nome =
        typeof req.body.nome === "string"
            ? req.body.nome.trim()
            : "";

    const quantidade = inteiroPositivo(req.body.quantidade);

    const unidade = texto(req.body.unidade, 20);

    const categoria = texto(req.body.categoria, 60);

    if (!nome || !quantidade || !unidade || !categoria) {
        return res.status(400).json({
            erro: "Preencha corretamente os dados do medicamento."
        });
    }

    const db = readDB();

    const existe = db.estoque.some(
        item =>
            item.nome.toLowerCase() === nome.toLowerCase()
    );

    if (existe) {
        return res.status(409).json({
            erro: "Este medicamento já está cadastrado. Utilize a reposição."
        });
    }

    const medicamento = {
        id: proximoId(db.estoque),
        nome,
        quantidade,
        unidade,
        categoria,
        createdAt: new Date().toISOString()
    };

    db.estoque.push(medicamento);

    const entrada = {
        id: proximoId(db.historicoEntradas),
        medicamentoId: medicamento.id,
        nome,
        quantidade,
        unidade,
        tipo: "Novo cadastro",
        obs: "",
        data: new Date().toISOString()
    };

    db.historicoEntradas.unshift(entrada);
    db.historicoEntradas = db.historicoEntradas.slice(0, 30);

    writeDB(db);

    res.status(201).json({
        mensagem: "Medicamento cadastrado com sucesso.",
        medicamento,
        entrada
    });
});

// Repor quantidade de medicamento
app.post("/almoxarifado/reposicao", (req, res) => {
    const medicamentoId = inteiroPositivo(req.body.id);
    const quantidade = inteiroPositivo(req.body.quantidade);

    const obs = texto(req.body.obs, 200);

    if (!medicamentoId || !quantidade) {
        return res.status(400).json({
            erro: "Informe um medicamento e uma quantidade válida."
        });
    }

    const db = readDB();

    const medicamento = db.estoque.find(
        item => item.id === medicamentoId
    );

    if (!medicamento) {
        return res.status(404).json({
            erro: "Medicamento não encontrado no estoque."
        });
    }

    if (
        !Number.isSafeInteger(medicamento.quantidade + quantidade)
    ) {
        return res.status(400).json({
            erro: "A quantidade informada é muito alta."
        });
    }

    medicamento.quantidade += quantidade;

    const entrada = {
        id: proximoId(db.historicoEntradas),
        medicamentoId: medicamento.id,
        nome: medicamento.nome,
        quantidade,
        unidade: medicamento.unidade,
        tipo: "Reposição",
        obs,
        data: new Date().toISOString()
    };

    db.historicoEntradas.unshift(entrada);
    db.historicoEntradas = db.historicoEntradas.slice(0, 30);

    writeDB(db);

    res.json({
        mensagem: "Estoque atualizado com sucesso.",
        medicamento,
        entrada
    });
});

// Consultar histórico de entradas
app.get("/almoxarifado/historico", (req, res) => {
    const db = readDB();

    res.json(db.historicoEntradas);
});

// ==================================================
// TRATAMENTO DE ROTAS E ERROS
// ==================================================

// Verificação rápida de que o servidor está no ar
app.get("/saude", (req, res) => {
    res.json({
        status: "ok",
        horario: new Date().toISOString()
    });
});

app.use((req, res) => {
    res.status(404).json({
        erro: "Rota não encontrada."
    });
});

app.use((erro, req, res, next) => {
    // JSON malformado enviado pelo cliente
    if (erro.type === "entity.parse.failed") {
        return res.status(400).json({
            erro: "JSON inválido."
        });
    }

    console.error("Erro na API:", erro);

    if (res.headersSent) {
        return next(erro);
    }

    const status = erro.status === 400 ? 400 : 500;

    res.status(status).json({
        erro:
            status === 400
                ? "Requisição inválida."
                : "Erro interno do servidor."
    });
});

// ==================================================
// INICIAR SERVIDOR
// ==================================================

if (require.main === module) {
    const porta = Number(process.env.PORT) || 3000;

    app.listen(porta, () => {
        console.log("==================================");
        console.log("       HOSPITAL PRO");
        console.log("==================================");
        console.log(`Servidor: http://localhost:${porta}`);
        console.log("Backend iniciado com sucesso!");
        console.log("==================================");
    });
}

module.exports = app;
module.exports.classificarRisco = classificarRisco;
module.exports.ORDEM_RISCO = ORDEM_RISCO;
