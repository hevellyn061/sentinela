/*
 * Camada comum de comunicação do Hospital Pro.
 *
 * Todas as telas usam este arquivo para falar com o servidor:
 *  - guarda o token da sessão (login);
 *  - manda o token em Authorization: Bearer <token>;
 *  - devolve o usuário para a tela de login se a sessão expirar;
 *  - oferece o botão de sair.
 */

(function () {
    "use strict";

    const CHAVE_TOKEN = "hospital.token";
    const CHAVE_USUARIO = "hospital.usuario";

    // Setores que podem abrir cada tela
    const ACESSO_POR_TELA = {
        "admin.html": ["admin"],
        "atendimento.html": ["admin", "atendimento"],
        "triagem.html": ["admin", "triagem"],
        "medico.html": ["admin", "medico"],
        "medicacoes.html": ["admin", "medico", "almoxarifado"],
        "atendimentos.html": ["admin", "medico", "atendimento"],
        "almoxarifado.html": ["admin", "almoxarifado"]
        // tv.html é pública: fica exposta na sala de espera
    };

    // ---------------- Sessão ----------------

    function token() {
        try {
            return localStorage.getItem(CHAVE_TOKEN);
        } catch (erro) {
            return null;
        }
    }

    function usuario() {
        try {
            const salvo = localStorage.getItem(CHAVE_USUARIO);
            return salvo ? JSON.parse(salvo) : null;
        } catch (erro) {
            return null;
        }
    }

    function guardarSessao(dados) {
        localStorage.setItem(CHAVE_TOKEN, dados.token);
        localStorage.setItem(
            CHAVE_USUARIO,
            JSON.stringify({
                usuario: dados.usuario,
                tipo: dados.tipo
            })
        );
    }

    function limparSessao() {
        localStorage.removeItem(CHAVE_TOKEN);
        localStorage.removeItem(CHAVE_USUARIO);
    }

    function irParaLogin() {
        limparSessao();

        if (!location.pathname.endsWith("/index.html") &&
            !location.pathname.endsWith("/")) {
            location.href = "index.html";
        }
    }

    // ---------------- Requisições ----------------

    async function requisicao(rota, opcoes = {}) {
        const { metodo = "GET", dados, autenticado = true } = opcoes;

        const cabecalhos = {
            ...(dados ? { "Content-Type": "application/json" } : {}),
            ...(opcoes.headers || {})
        };

        const chave = token();

        if (autenticado && chave) {
            cabecalhos.Authorization = `Bearer ${chave}`;
        }

        let resposta;

        try {
            resposta = await fetch(rota, {
                method: metodo,
                cache: "no-store",
                headers: cabecalhos,
                ...(dados ? { body: JSON.stringify(dados) } : {})
            });
        } catch (erro) {
            throw new Error(
                "Não foi possível conectar ao servidor. Verifique se ele está funcionando."
            );
        }

        const corpo = await resposta.json().catch(() => ({}));

        // Sessão inválida ou expirada: volta para o login
        if (autenticado && resposta.status === 401) {
            irParaLogin();
            throw new Error(corpo.erro || "Sessão expirada. Faça login novamente.");
        }

        if (!resposta.ok) {
            throw new Error(
                corpo.erro || corpo.mensagem || `Erro ${resposta.status} na operação.`
            );
        }

        return corpo;
    }

    // ---------------- Proteção das telas ----------------

    function proteger(pagina) {
        const exigidos = ACESSO_POR_TELA[pagina];
        const logado = usuario();

        if (!token() || !logado) {
            location.href = "index.html";
            return null;
        }

        montarBarra();

        if (exigidos && !exigidos.includes(logado.tipo)) {
            alert("Seu setor não tem acesso a esta tela.");
            location.href = "index.html";
            return null;
        }

        // Confere com o servidor se a sessão continua válida
        requisicao("/sessao")
            .then(dados => {
                localStorage.setItem(CHAVE_USUARIO, JSON.stringify(dados));
                pintarUsuario(dados);
            })
            .catch(() => {});

        pintarUsuario(logado);

        return logado;
    }

    // ---------------- Cabeçalho com usuário e "Sair" ----------------

    function pintarUsuario(logado) {
        if (!logado) {
            return;
        }

        // Telas que já mostram o usuário no próprio cabeçalho não
        // recebem a barra flutuante.
        const noCabecalho = document.querySelector(
            "header [data-usuario-logado]"
        );

        const alvos = document.querySelectorAll("[data-usuario-logado]");

        alvos.forEach(alvo => {
            alvo.textContent = `${logado.usuario} (${logado.tipo})`;
        });

        if (noCabecalho) {
            return true;
        }

        return false;
    }

    function montarBarra(prefixo = "") {
        const logado = usuario();

        if (!logado) {
            return;
        }

        if (document.querySelector(".barra-sessao")) {
            return;
        }

        const barra = document.createElement("div");
        barra.className = "barra-sessao";
        barra.innerHTML = `
            <span data-usuario-logado></span>
            <button type="button" class="btn-sair">Sair</button>
        `;

        barra.querySelector(".btn-sair").addEventListener("click", sair);
        barra.querySelector("[data-usuario-logado]").textContent =
            `${logado.usuario} (${logado.tipo})`;

        if (pintarUsuario(logado)) {
            return;
        }

        document.body.appendChild(barra);
    }

    async function sair() {
        try {
            await requisicao("/logout", { metodo: "POST", dados: {} });
        } catch (erro) {
            // Se o servidor já derrubou a sessão, segue para o login de qualquer forma
        } finally {
            limparSessao();
            location.href = "index.html";
        }
    }

    // ---------------- Situações do paciente ----------------

    // Nomes que aparecem na tela para cada situação do paciente
    const SITUACOES = {
        triagem: "Aguardando triagem",
        aguardando_chamada: "Aguardando chamada",
        aguardando_medico: "Chamado para a sala médica",
        em_atendimento: "Em atendimento",
        internado: "Internado (observação)",
        alta: "Alta",
        obito: "Óbito",
        evasao: "Evasão",
        transferido: "Transferido"
    };

    // Situações em que o paciente já saiu do fluxo
    const ENCERRADOS = ["alta", "obito", "evasao", "transferido"];

    function situacao(status) {
        return SITUACOES[status] || status || "—";
    }

    function encerrado(status) {
        return ENCERRADOS.includes(status);
    }

    // Classe de etiqueta usada nas listas
    function classeSituacao(status) {
        if (status === "alta") return "etiqueta etiqueta-verde";
        if (status === "obito") return "etiqueta etiqueta-vermelha";
        if (status === "evasao" || status === "transferido") {
            return "etiqueta etiqueta-cinza";
        }
        if (status === "internado") return "etiqueta etiqueta-azul";
        if (status === "aguardando_medico" || status === "em_atendimento") {
            return "etiqueta etiqueta-amarela";
        }
        return "etiqueta";
    }

    // Data/hora no formato brasileiro
    function dataHora(valor) {
        if (!valor) {
            return "—";
        }

        const data = new Date(valor);

        return Number.isNaN(data.getTime())
            ? "—"
            : data.toLocaleString("pt-BR");
    }

    // ---------------- Exportação ----------------

    window.Api = {
        token,
        usuario,
        guardarSessao,
        limparSessao,
        requisicao,
        proteger,
        sair,
        montarBarra,
        SITUACOES,
        ENCERRADOS,
        situacao,
        encerrado,
        classeSituacao,
        dataHora
    };
})();
