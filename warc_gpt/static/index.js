/*------------------------------------------------------------------------------
 * Module-level references / state
 -----------------------------------------------------------------------------*/

/** Keeps track of "basic" chat history. To be fed back to the API after each exchange. */
let history = [];

/** Full exchanges history with metadata, indexed by id_exchange. */
const exchanges = {}; 

/** If `true`, user should not be able to send another request. */
let isLoading = false;

const modelSelect = document.querySelector("#model");
const temperatureSelect = document.querySelector("#temperature");
const maxTokensInput = document.querySelector("#max_tokens");
const noRagSelect = document.querySelector("#no_rag");
const noHistorySelect = document.querySelector("#no_history");
const ragPromptOverrideButton = document.querySelector("button.rag_prompt_override");

const ragPromptOverrideDialog = document.querySelector("dialog.rag_prompt_override");
const ragPromptOverrideCloseButton = document.querySelector("dialog.rag_prompt_override button.close");
const ragPromptOverrideInput = document.querySelector("#rag_prompt_override");

const chatUI = document.querySelector("#chat-ui");
const chatInput = document.querySelector("#chat-input");

const messageInput = document.querySelector("#message");
const askButton = document.querySelector("#ask");


/*------------------------------------------------------------------------------
 * Utilities
 -----------------------------------------------------------------------------*/
/**
 * Escapes a string so it can be rendered as part of an HTML document.
 * @param {string} string 
 * @param {boolean} convertLineBreaks - If true, replaces \n with <br>
 * @returns {string}
 */
const sanitizeString = (string, convertLineBreaks = true) => {
  string = string
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  if (convertLineBreaks === true) {
    string = string.replaceAll("\n", "<br>");
  }

  return string;
}


/*------------------------------------------------------------------------------
 * Chat Mechanism
 -----------------------------------------------------------------------------*/
/**
 * On "chat" form submit:
 * - Pull settings and message
 * - Trigger loading state 
 * - Ask API
 * - Render additions to chat UI
 */
chatInput.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Assemble completion payload
  const message = messageInput.value.trim();
  const model = modelSelect.value.trim();
  const temperature = parseFloat(temperatureSelect.value).toFixed(1);
  const maxTokens = maxTokensInput.value === "" ? null : parseInt(maxTokensInput.value);
  const noRag = noRagSelect.value === "true" ? true : false;
  const noHistory = noHistorySelect.value === "true" ? true : false;
  const ragPromptOverride = ragPromptOverrideInput.value.trim();

  const payload = { 
    model,
    message,
    temperature,
    history: noHistory ? [] : history,
    no_rag: noRag,
    rag_prompt_override: ragPromptOverride
  }

  if (maxTokens !== null) {
    payload["max_tokens"] = maxTokens;
  }

  //
  // Append question to chat UI
  //
  chatUI.insertAdjacentHTML(
    "beforeend", 
    /*html*/`<article class="message user">${sanitizeString(message)}</article>`
  );

  chatUI.scroll({
    top: chatUI.scrollHeight,
    left: 0,
    behavior: "smooth"
  });

  //
  // Raise loading state
  //
  isLoading = true;
  askButton.setAttribute("disabled", "disabled");
  messageInput.setAttribute("disabled", "disabled");
  messageInput.value = "Please wait ..."

  let seenInitialMetadata = false;

  //
  // Query API and process response
  //
  try {

    const response = await fetch("/api/completion", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(payload)
    })

    // We are going to stream back JSON lines data from the API as LLM text becomes
    // available. The first JSON object contains metadata about the request. And
    // subsequent JSON objects contain chunks of text from the LLM.
    const reader = response.body.getReader();

    let runningText = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const text = new TextDecoder().decode(value);
      const lines = text.split("\n");

      for (const line of lines) {
        try {
          runningText += line;
          const data = JSON.parse(line);
          runningText = "";

          if (! seenInitialMetadata) {
            seenInitialMetadata = true;
            addInitialResponse(data, chatUI, noHistory);
          } else if (data.message) {
            addResponse(data, chatUI);
          } else if (!noHistory) {
            addHistory(data);
          }
        } catch({ name, message }) {
          // Because of buffering we may get partial JSON so we need to
          // accumulate runningText until the JSON string parses.
          //
          // So, we can ignore JSON.parse errors, but any other error is a
          // problem.
          if (! message.match(/JSON.parse/)) {
            throw new Error(`Error while reading from completion API: ${name} ${message}`);
          }
        }
      }
    }
  } catch(err) {
    // Put unprocessed message back in textarea
    messageInput.value = sanitizeString(message, false);

    // Show error message
    chatUI.insertAdjacentHTML("beforeend", 
      /*html*/`
      <article class="message ai errror">
      <p class="model">Error</p>
      <p class="response">An error occurred while processing the request.</p>
      </article>`    
    );

    throw(err);
  } finally {
    messageInput.removeAttribute("disabled");
    isLoading = false;
  }
});

/**
 * Add the initial framing of the response.
 */
function addInitialResponse(data, chatUI, noHistory) {
  history = data.history;
  exchanges[data.id_exchange] = data;

  // data-id-exchange="${data.id_exchange}" shortcut
  const dataAttr = `data-id-exchange="${data.id_exchange}"`;

  //
  // Append response to chat UI 
  //
  chatUI.insertAdjacentHTML("beforeend", 
    /*html*/`
    <article id="exchange-${data.id_exchange}" class="message ai">
    <p class="model">${sanitizeString(data.request_info.model)}</p>
    <p class="response"></p>
    </article>`    
  );

  //
  // Append "action" buttons to chat UI
  //
  if (!data.no_rag) {
    chatUI.insertAdjacentHTML("beforeend", 
      /*html*/`
      <article class="actions">
        <button class="show-sources" ${dataAttr}>Show sources</button>
        <button class="copy-as-json" ${dataAttr}>Copy as JSON</button>
      </article>`
    ); 
  } else {
    chatUI.insertAdjacentHTML("beforeend", 
      /*html*/`
      <article class="actions">
        <button class="copy-as-json" ${dataAttr}>Copy as JSON</button>
      </article>`
    );
  }

  //
  // Create and inject "Show Sources" dialog
  //
  let showSourcesDialogHTML = ""

  // Add individual sources
  for (const context of data.context) {
    showSourcesDialogHTML += /*html*/`
    <h3>${sanitizeString(context.warc_filename)}</h3>

    <table>
      <tr>
        <td>URL: </td>
        <td>
          <a href="${sanitizeString(context.warc_record_target_uri, false)}">
            ${sanitizeString(context.warc_record_target_uri, false)}
          </a>
        </td>
      </tr>

      <tr>
        <td>Date: </td>
        <td><span>${sanitizeString(context.warc_record_date, false)}</span></td>
      </tr>

      <tr>
        <td>Record ID: </td>
        <td><span>${sanitizeString(context.warc_record_id, false)}</span></td>
      </tr>
    </table>
    
    <textarea disabled>${sanitizeString(context.warc_record_text, false)}</textarea>
    `;
  }

  // Add retrieval prompt to dialog
  if (!data.no_rag) {
    showSourcesDialogHTML += /*html*/`
      <h3>Retrieval Prompt</h3>
      <textarea disabled>${sanitizeString(data.request_info.message_plus_prompt, false)}</textarea>
    `;
  }

  // Inject dialog in DOM
  if (!data.request_info.no_rag) {
    chatUI.insertAdjacentHTML("beforeend", 
      /*html*/`
      <dialog class="show-sources" data-id-exchange="${data.id_exchange}">
        <button class="close">Close</button>
        <h2>Sources</h2>
        ${showSourcesDialogHTML}
      </dialog>`
    );
  }

  //
  // Create event listeners for "Show sources"
  //
  if (!data.request_info.no_rag) {
    const showSourcesDialog = document.querySelector(`dialog[${dataAttr}]`);
    const showSourcesOpenButton = document.querySelector(`button.show-sources[${dataAttr}]`);
    const showSourcesCloseButton = document.querySelector(`dialog[${dataAttr}] button.close`);
    
    showSourcesOpenButton.addEventListener("click", e => {
      showSourcesDialog.showModal();
    });

    showSourcesCloseButton.addEventListener("click", e => {
      showSourcesDialog.close();
    });

    showSourcesDialog.addEventListener("click", e => { // Backdrop click closes the dialog
      showSourcesDialog.close();
    });
  }

  //
  // Create event listeners for "Copy as JSON".
  //
  const copyAsJSONButton = document.querySelector(`button.copy-as-json[${dataAttr}]`);

  copyAsJSONButton.addEventListener("click", e => {
    const jsonExport = JSON.stringify(exchanges[data.id_exchange]);
    navigator.clipboard.writeText(jsonExport);
  })

  // Scroll just enough to reveal new message
  chatUI.scroll({
    top: chatUI.scrollTop + 75, 
    left: 0, 
    behavior: "smooth"
  });

  // Clear chat input so placeholder shows
  messageInput.value = "";
}

/**
 * Add a chunk of the response.
 */
function addResponse(data, chatUI) {
  const id = data.id_exchange
  const response = document.querySelector(`#exchange-${id} .response`);
  response.innerHTML += sanitizeString(data.message);
  chatUI.scroll({
    top: chatUI.scrollHeight,
    left: 0,
    behavior: "smooth"
  });
}

/**
 * Add the chat history.
 */
function addHistory(data) {
  let historyAsText = /*html*/``;
  for (const message of data.history) {
    historyAsText += `${message.role}: ${message.content.trim()}\n`
  }

  const dialogs = document.querySelectorAll('dialog.show-sources');
  const dialog = dialogs[dialogs.length - 1];

  dialog.innerHTML += /*html*/`
    <h3 id="history">Chat History</h3>
    <textarea disabled>${sanitizeString(historyAsText, false)}</textarea>
  `;
}



/**
 * Automatically activate / deactivate "Ask WARC GPT" button.
 * Runs every 100ms.
 */
setInterval(() => {
  const messageOk = messageInput.value.trim().length > 0;
  const modelOk = modelSelect.value.trim().length > 0;
  const temperatureOk = temperatureSelect.value.match(/[0-9]\.[0-9]/) != null;
  const maxTokensOk = maxTokensInput.value === "" || maxTokensInput.value.match(/[0-9]+/) != null;
  const noRagOk = ["true", "false"].includes(noRagSelect.value);
  const noHistoryOk = ["true", "false"].includes(noHistorySelect.value);

  // Activate "Ask" button if all is OK
  if (!isLoading && messageOk && modelOk && temperatureOk && maxTokensOk && noRagOk && noHistoryOk) {
    askButton.removeAttribute("disabled");
  } else {
    askButton.setAttribute("disabled", "disabled");
  }
}, 100);


/*------------------------------------------------------------------------------
 * Rag Prompt Override Dialog
 -----------------------------------------------------------------------------*/
ragPromptOverrideButton.addEventListener("click", e => {
  e.preventDefault();
  ragPromptOverrideDialog.showModal();
});

ragPromptOverrideCloseButton.addEventListener("click", e => {
  e.preventDefault();
  ragPromptOverrideDialog.close();
});

