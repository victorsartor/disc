// Captura o som do sistema EXCLUINDO a Disneia — no Windows.
//
// O PROBLEMA. O app pede o audio da tela com `chromeMediaSource: 'desktop'`,
// que e o loopback do sistema INTEIRO: a voz das pessoas da chamada sai pela
// mesma caixa e entra na transmissao junto. Quem assiste se ouve de volta.
// No Linux isso se resolve orquestrando o servidor de som por fora (ver
// electron/audio-linux.ts); no Windows nao existe esse controle, e o
// Chromium nao expoe nada alem do loopback total — conferido nos typings do
// Electron 33: `audio: 'loopback' | 'loopbackWithMute'`, sem exclusao.
//
// A SAIDA. O Windows tem a API certa desde o build 20348:
// ActivateAudioInterfaceAsync com AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
// e ProcessLoopbackMode = EXCLUDE_TARGET_PROCESS_TREE. Ela devolve tudo que
// esta tocando MENOS a arvore de processos que apontarmos. Apontamos pra nos
// mesmos, e o processo de audio do Chromium — que e filho do nosso — sai
// junto, que e exatamente o que precisamos.
//
// MEDIDO, NAO SUPOSTO: um processo filho tocando um WAV aparece com pico
// 0,32 no modo INCLUDE e 0,006 (piso de ruido) no EXCLUDE, com tudo o mais
// igual. Confirmado tambem de dentro do processo main do Electron.
//
// O QUE ESTE ARQUIVO ENTREGA: quadros PCM float32 crus, por callback. Virar
// faixa de midia e trabalho do lado JS (ver src/lib/audio-win.ts) — aqui nao
// se sabe o que e LiveKit.

#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <propidl.h>
#include <atomic>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "ole32.lib")

namespace {

/**
 * O handler que a ActivateAudioInterfaceAsync exige.
 *
 * PRECISA declarar IAgileObject. Sem isso a chamada falha com
 * E_ILLEGAL_METHOD_CALL (0x8000000E) antes mesmo de tentar qualquer coisa —
 * descoberto rodando, nao lendo. O resultado volta numa thread do sistema, e
 * o COM so entrega uma callback atravessando apartamentos se o objeto se
 * declarar agil. E o papel que o FtmBase do WRL cumpre na amostra oficial da
 * Microsoft; aqui e feito na mao, sem arrastar o WRL pra dentro do projeto.
 */
class ActivationHandler : public IActivateAudioInterfaceCompletionHandler,
                          public IAgileObject {
public:
  ActivationHandler() : refs_(1) {
    doneEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  }
  ~ActivationHandler() {
    if (doneEvent_) CloseHandle(doneEvent_);
  }

  HANDLE Event() const { return doneEvent_; }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override {
    if (riid == IID_IUnknown || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
      AddRef();
      return S_OK;
    }
    if (riid == __uuidof(IAgileObject)) {
      *ppv = static_cast<IAgileObject *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs_); }
  ULONG STDMETHODCALLTYPE Release() override {
    LONG r = InterlockedDecrement(&refs_);
    if (r == 0) delete this;
    return r;
  }

  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation *) override {
    SetEvent(doneEvent_);
    return S_OK;
  }

private:
  LONG refs_;
  HANDLE doneEvent_ = nullptr;
};

/** Estado da captura em andamento. So existe uma por processo. */
struct Sessao {
  std::thread thread;
  std::atomic<bool> parar{false};
  Napi::ThreadSafeFunction tsfn;
  std::string erro;      // preenchido pela thread se ela morrer cedo
  std::atomic<bool> viva{false};
};

Sessao *sessao = nullptr;

/**
 * O laco de captura. Roda numa thread propria — nunca na thread do JS.
 *
 * Cada pacote que chega vira uma chamada da callback do lado JS, com os
 * quadros float32 intercalados. A ThreadSafeFunction e o que torna isso
 * legal: chamar direto uma funcao JS de outra thread derrubaria o processo.
 */
void LacoDeCaptura(DWORD pidAlvo, DWORD taxa, WORD canais) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool precisaUninit = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;

  IAudioClient *client = nullptr;
  IAudioCaptureClient *captura = nullptr;
  HANDLE evtBuffer = nullptr;

  auto encerrar = [&](const char *onde, HRESULT codigo) {
    if (onde) {
      char buf[160];
      snprintf(buf, sizeof(buf), "%s falhou (0x%08lx)", onde, static_cast<unsigned long>(codigo));
      sessao->erro = buf;
    }
    if (captura) captura->Release();
    if (client) client->Release();
    if (evtBuffer) CloseHandle(evtBuffer);
    if (precisaUninit) CoUninitialize();
    sessao->viva = false;
    sessao->tsfn.Release();
  };

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pidAlvo;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  // VT_BLOB apontando pra struct na STACK. De proposito nao chamamos
  // PropVariantClear: ela tentaria CoTaskMemFree um ponteiro que nunca foi
  // alocado no heap. Mesmo padrao da amostra oficial da Microsoft.
  PROPVARIANT pv = {};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE *>(&params);

  ActivationHandler *handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation *op = nullptr;

  hr = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler, &op);
  if (FAILED(hr)) {
    handler->Release();
    encerrar("ActivateAudioInterfaceAsync", hr);
    return;
  }

  if (WaitForSingleObject(handler->Event(), 5000) != WAIT_OBJECT_0) {
    if (op) op->Release();
    handler->Release();
    encerrar("espera pela ativacao", E_ABORT);
    return;
  }

  HRESULT hrAtivacao = E_FAIL;
  IUnknown *ativada = nullptr;
  hr = op->GetActivateResult(&hrAtivacao, &ativada);
  op->Release();
  handler->Release();

  if (FAILED(hr) || FAILED(hrAtivacao) || !ativada) {
    if (ativada) ativada->Release();
    encerrar("ativacao do cliente de audio", FAILED(hr) ? hr : hrAtivacao);
    return;
  }

  hr = ativada->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void **>(&client));
  ativada->Release();
  if (FAILED(hr) || !client) {
    encerrar("QueryInterface(IAudioClient)", hr);
    return;
  }

  // O formato vem de fora porque quem manda e o AudioContext do renderer: se
  // pedirmos uma taxa diferente da dele, alguem teria que reamostrar, e o
  // mecanismo de loopback do Windows ja faz isso de graca aqui.
  WAVEFORMATEX wfx = {};
  wfx.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  wfx.nChannels = canais;
  wfx.nSamplesPerSec = taxa;
  wfx.wBitsPerSample = 32;
  wfx.nBlockAlign = static_cast<WORD>(canais * 32 / 8);
  wfx.nAvgBytesPerSec = taxa * wfx.nBlockAlign;

  evtBuffer = CreateEventW(nullptr, FALSE, FALSE, nullptr);

  // 200ms de folga interna. hnsPeriodicity tem que ser 0 em shared mode:
  // quem decide o periodo e o motor de audio, nao nos.
  hr = client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
      2000000, 0, &wfx, nullptr);
  if (FAILED(hr)) {
    encerrar("IAudioClient::Initialize", hr);
    return;
  }

  hr = client->SetEventHandle(evtBuffer);
  if (FAILED(hr)) {
    encerrar("SetEventHandle", hr);
    return;
  }

  hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void **>(&captura));
  if (FAILED(hr) || !captura) {
    encerrar("GetService(IAudioCaptureClient)", hr);
    return;
  }

  hr = client->Start();
  if (FAILED(hr)) {
    encerrar("IAudioClient::Start", hr);
    return;
  }

  sessao->viva = true;

  while (!sessao->parar.load()) {
    // Timeout curto: e ele que permite notar o pedido de parada mesmo
    // quando nao ha audio nenhum chegando (o evento nao dispara em
    // silencio absoluto).
    if (WaitForSingleObject(evtBuffer, 200) != WAIT_OBJECT_0) continue;

    UINT32 tamanho = 0;
    if (FAILED(captura->GetNextPacketSize(&tamanho))) break;

    while (tamanho > 0 && !sessao->parar.load()) {
      BYTE *dados = nullptr;
      UINT32 quadros = 0;
      DWORD flags = 0;
      if (FAILED(captura->GetBuffer(&dados, &quadros, &flags, nullptr, nullptr))) break;

      if (quadros > 0) {
        const size_t total = static_cast<size_t>(quadros) * canais;
        auto *bloco = new std::vector<float>(total);
        // Silencio vem SEM dados validos no ponteiro: o buffer ja nasce
        // zerado, entao e so nao copiar. Continuar enviando o bloco (em vez
        // de pular) mantem o relogio do lado JS andando junto com o real.
        if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && dados) {
          memcpy(bloco->data(), dados, total * sizeof(float));
        }

        napi_status st = sessao->tsfn.BlockingCall(
            bloco, [](Napi::Env env, Napi::Function cb, std::vector<float> *b) {
              // Copia pro heap do V8. O Buffer::Copy e o caminho barato: um
              // Float32Array por cima do mesmo espaco do lado JS.
              auto buffer = Napi::Buffer<float>::Copy(env, b->data(), b->size());
              delete b;
              cb.Call({buffer});
            });
        // Fila cheia ou TSFN fechando: descarta o bloco em vez de vazar.
        if (st != napi_ok) delete bloco;
      }

      captura->ReleaseBuffer(quadros);
      if (FAILED(captura->GetNextPacketSize(&tamanho))) break;
    }
  }

  client->Stop();
  encerrar(nullptr, S_OK);
}

/** start(pidAlvo, taxa, canais, callback) — comeca a capturar. */
Napi::Value Start(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (sessao != nullptr) {
    Napi::Error::New(env, "ja existe uma captura em andamento").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  DWORD taxa = info[1].As<Napi::Number>().Uint32Value();
  WORD canais = static_cast<WORD>(info[2].As<Napi::Number>().Uint32Value());
  Napi::Function cb = info[3].As<Napi::Function>();

  sessao = new Sessao();
  sessao->tsfn = Napi::ThreadSafeFunction::New(
      env, cb, "captura-audio-win", 0 /* fila sem teto */, 1 /* uma thread */);

  sessao->thread = std::thread(LacoDeCaptura, pid, taxa, canais);
  return env.Undefined();
}

/** stop() — para e espera a thread sair. Seguro de chamar sem ter comecado. */
Napi::Value Stop(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (sessao == nullptr) return env.Undefined();

  sessao->parar = true;
  if (sessao->thread.joinable()) sessao->thread.join();

  std::string erro = sessao->erro;
  delete sessao;
  sessao = nullptr;

  // O erro da thread so pode ser contado agora: quando o start() voltou, ela
  // mal tinha comecado. Quem chama decide se isso vira aviso na tela.
  if (!erro.empty()) return Napi::String::New(env, erro);
  return env.Undefined();
}

/** Verdadeiro enquanto a thread estiver capturando de fato. */
Napi::Value Ativa(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), sessao != nullptr && sessao->viva.load());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("ativa", Napi::Function::New(env, Ativa));
  return exports;
}

} // namespace

NODE_API_MODULE(audio_win, Init)
