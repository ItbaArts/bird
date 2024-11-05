const fs = require("fs");
const path = require("path");
const axios = require("axios");
const WebSocket = require("ws");
const winston = require("winston");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.printf(({ level, message }) => {
      return `[⚔] | ${level.toUpperCase()} | ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

class Birdton {
  constructor() {
    const config = require('./config.json');
    
    this.config = {
      baseURL: config.baseURL,
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br", 
        "Accept-Language": "en-US;q=0.8,en;q=0.7",
        Connection: "keep-alive",
        "Content-Type": "application/json",
        Origin: "https://birdton.site",
        Referer: "https://birdton.site/",
        "Sec-Ch-Ua":
          '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?1",
        "Sec-Ch-Ua-Platform": '"Android"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      },
      maxBoostLevel: config.maxBoostLevel,
      game: config.game
    };

    this.state = {
      remainingEnergy: 0,
      authKey: "",
      payload: {},
      ws: null,
      balance: 0,
      coinValues: {},
      currentBoost: null,
      currentTask: null,
      initialAdsLeft: 0,
      adsProcessed: true,
      userId: "",
    };
  }

  formatBalance(balance) {
    if (balance >= 1000000000) {
      return `${(balance / 1000000000).toFixed(1)}B`;
    }
    if (balance >= 1000000) {
      return `${(balance / 1000000).toFixed(1)}M`;
    }
    if (balance >= 1000) {
      return `${(balance / 1000).toFixed(1)}K`;
    }
    return balance.toString();
  }

  async waitForTaskCompletion() {
    if (this.state.currentTask) {
      await this.state.currentTask;
      this.state.currentTask = null;
    }
  }

  async fetchAds(userId) {
    const url = `https://api.adsgram.ai/adv?blockId=604&tg_id=${userId}&tg_platform=android&platform=Win32&language=en`;
    try {
      const response = await axios.get(url, { headers: this.config.headers });
      const data = response.data;

      const renderUrl = data.banner.trackings.find(
        (tracking) => tracking.name === "render"
      ).value;
      const showUrl = data.banner.trackings.find(
        (tracking) => tracking.name === "show"
      ).value;
      const rewardUrl = data.banner.trackings.find(
        (tracking) => tracking.name === "reward"
      ).value;

      await axios.get(renderUrl, { headers: this.config.headers });
      await axios.get(showUrl, { headers: this.config.headers });
      await axios.get(rewardUrl, { headers: this.config.headers });

      this.state.ws.send(JSON.stringify({ event_type: "ad_reward", data: "" }));
      logger.info("Processing ad");
    } catch (error) {
      logger.error("Failed to get ad data", {
        error: error.message,
      });
    }
  }

  sendGameIdMessage() {
    if (this.state.ws && this.state.ws.readyState === WebSocket.OPEN) {
      const { min, max } = this.config.game.messageCount;
      const { avg } = this.config.game.interval;
      
      const totalMessages = Math.floor(Math.random() * (max - min + 1)) + min;
      const avgInterval = avg;
      const totalTimeSeconds = Math.ceil((totalMessages * avgInterval) / 1000);
      
      let countdown = totalTimeSeconds;
      const timer = setInterval(() => {
        const minutes = Math.floor(countdown / 60);
        const seconds = countdown % 60;
        process.stdout.write(`\rGame time left: ${minutes}m ${seconds}s             `);
        
        countdown--;
        if (countdown < 0) {
          clearInterval(timer);
          process.stdout.write('\n');
        }
      }, 1000);

      logger.info(
        `Starting game (Score: ${totalMessages} | Time: ${totalTimeSeconds}s)`
      );

      const gameIdMessage = {
        event_type: "game_id",
        data: "std",
      };
      this.state.ws.send(JSON.stringify(gameIdMessage));
    }
  }

  sendPipeMessages(gameData) {
    let messageCount = 0;
    const { min, max } = this.config.game.messageCount;
    const totalMessages = Math.floor(Math.random() * (max - min + 1)) + min;
    let totalTime = 0;
    const startTime = Date.now();
    const TEN_MINUTES = 10 * 60 * 1000; 
    const TWENTY_MINUTES = 20 * 60 * 1000; 

    const sendPipeMessage = () => {
      if (messageCount < totalMessages) {
        const pipeMessage = {
          event_type: "pipe",
          data: gameData,
        };
        this.state.ws.send(JSON.stringify(pipeMessage));
        messageCount++;

        const currentTime = Date.now();
        const elapsedTime = currentTime - startTime;
        const { min: minInterval, max: maxInterval, avg: avgInterval } = this.config.game.interval;
        
        let interval;
        if (elapsedTime < TEN_MINUTES) {
          interval = maxInterval;
        } else if (elapsedTime < TWENTY_MINUTES) {
          interval = avgInterval;
        } else {
          interval = minInterval;
        }

        totalTime += interval;
        setTimeout(sendPipeMessage, interval);
      } else {
        const gameEndMessage = {
          event_type: "game_end",
          data: gameData,
        };
        this.state.ws.send(JSON.stringify(gameEndMessage));
        logger.warn(
          `Game ended (Time: ${(totalTime / 1000).toFixed(1)}s)`
        );
        this.state.remainingEnergy--;
      }
    };

    sendPipeMessage();
  }

  async buyBoost(boostId, boostValue) {
    const requiredBalance = this.state.coinValues[boostValue];
    const safetyMargin = 1000;

    if (boostValue >= this.config.maxBoostLevel) {
      logger.info("Max boost reached. Starting game...");
      this.sendGameIdMessage();
      return;
    }

    if (!requiredBalance) {
      logger.warn("Invalid boost. Starting game...");
      this.sendGameIdMessage();
      return;
    }

    if (this.state.balance > (requiredBalance + safetyMargin)) {
      logger.info(
        `Buying boost. Need: ${this.formatBalance(
          requiredBalance
        )}`
      );
      const boostBuyMessage = {
        event_type: "boost_buy",
        data: boostId.toString(),
      };
      this.state.ws.send(JSON.stringify(boostBuyMessage));
    } else {
      logger.warn(`Not enough coins (Need: ${this.formatBalance(requiredBalance)})`);
      this.sendGameIdMessage();
    }
  }

  connectWebSocket(auth_key, payload, balance) {
    const wsURL = `wss://birdton.site/ws?auth=${encodeURIComponent(auth_key)}`;
    this.state.ws = new WebSocket(wsURL);
    this.state.balance = balance;

    this.state.ws.on("open", () => {
      logger.info("Connected to WebSocket");
      const message = {
        event_type: "auth",
        data: JSON.stringify(payload),
      };
      this.state.ws.send(JSON.stringify(message));
    });

    this.state.ws.on("message", async (message) => {
      try {
        const parsedMessage = JSON.parse(message.toString("utf8"));
        await this.handleWebSocketMessage(parsedMessage);
      } catch (error) {
        logger.error("Failed to parse message", {
          error: error.message,
        });
      }
    });

    this.state.ws.on("close", () => {
      logger.warn("WebSocket closed");
    });

    this.state.ws.on("error", (error) => {
      logger.error("WebSocket error", { error: error.message });
    });
  }

  async handleWebSocketMessage(parsedMessage) {
    switch (parsedMessage.event_type) {
      case "boost":
        await this.handleBoostMessage(parsedMessage);
        break;
      case "buy_boost_result":
        await this.handleBuyBoostResult(parsedMessage);
        break;
      case "game_id":
        if (parsedMessage.data.includes(":")) {
          await this.handleGameIdMessage(parsedMessage);
        }
        break;
      case "game_saved":
        await this.handleGameSaved(parsedMessage);
        break;
    }
  }

  async handleBoostMessage(message) {
    if (!this.state.adsProcessed && this.state.ads_left > 0) {
      await this.handleAds(this.state.userId);
      this.state.adsProcessed = true;
    }

    const boostData = JSON.parse(message.data);
    const coinValues = boostData.price_config.coin_value;
    const boost = boostData.boosts[0];
    const boostValue = boost.value;

    this.state.coinValues = coinValues;
    this.state.currentBoost = boost;

    if (boostValue >= this.config.maxBoostLevel) {
      logger.info(`Max boost ${this.config.maxBoostLevel} reached`);
      this.sendGameIdMessage();
      return;
    }

    const requiredCoinValue = coinValues[boostValue] || 0;
    logger.info(
      `Boost - Level: ${boostValue} | Need: ${this.formatBalance(
        requiredCoinValue
      )}`
    );
    await this.buyBoost(boost.id, boostValue);
  }

  async handleBuyBoostResult(message) {
    const buyBoostResult = JSON.parse(message.data);
    if (buyBoostResult.result === "success") {
      this.state.balance -= buyBoostResult.price;
      logger.info(
        `Boost bought. Balance: ${this.formatBalance(
          this.state.balance
        )}`
      );

      const nextLevel = this.state.currentBoost.value + 1;
      if (nextLevel >= this.config.maxBoostLevel) {
        logger.info(
          "Max boost reached. Starting game..."
        );
        this.sendGameIdMessage();
        return;
      }

      await this.buyBoost(this.state.currentBoost.id, nextLevel);
    } else {
      logger.warn(`Failed to buy boost: ${buyBoostResult.reason}`);
      this.sendGameIdMessage();
    }
  }

  async handleGameIdMessage(message) {
    const gameData = message.data;
    const gameStartMessage = {
      event_type: "game_start",
      data: gameData,
    };
    this.state.ws.send(JSON.stringify(gameStartMessage));
    setTimeout(() => {
      this.sendPipeMessages(gameData);
    }, 2000);
  }

  async handleGameSaved(message) {
    const gameSavedData = JSON.parse(message.data);
    logger.info(
      `Game stats - Score: ${
        gameSavedData.score
      } | Balance: ${this.formatBalance(gameSavedData.balance)} | Energy: ${
        this.state.remainingEnergy
      }`
    );

    if (this.state.remainingEnergy > 0) {
      logger.info(
        `Playing next game. Energy left: ${this.state.remainingEnergy}`
      );
      this.sendGameIdMessage();
    } else {
      logger.warn("No energy left. Stopping");
      this.state.ws.close();
    }
  }

  async auth(payload, userData) {
    try {
      const url = `${this.config.baseURL}/auth`;
      const response = await axios.post(url, payload, {
        headers: this.config.headers,
      });
      const { auth_key, balance, energy, ads_left } = response.data;

      Object.assign(this.state, {
        authKey: auth_key,
        payload,
        remainingEnergy: energy,
        balance,
        initialAdsLeft: ads_left,
        ads_left,
        adsProcessed: true,
        userId: userData.id,
      });

      logger.info(
        `Stats - Balance: ${this.formatBalance(
          balance
        )} | Energy: ${energy} | Ads: ${ads_left}`
      );

      if (energy > 0) {
        this.connectWebSocket(auth_key, payload, balance);
        this.state.currentTask = new Promise((resolve) => {
          this.state.ws.on("close", resolve);
        });
        await this.state.currentTask;
      } else {
        logger.warn("No energy");
      }

      return response.data;
    } catch (error) {
      logger.error("Auth failed", { error: error.message });
    }
  }

  async handleAds(userId) {
    for (let i = 0; i < this.state.initialAdsLeft; i++) {
      await this.fetchAds(userId);
    }
  }

  countdown(seconds) {
    let lastOutput = "";

    return new Promise((resolve) => {
      process.stdout.write("\n"); 
      const timer = setInterval(() => {
        const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
        const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(
          2,
          "0"
        );
        const remainingSeconds = String(seconds % 60).padStart(2, "0");
        const output = `Next run in: ${hours}:${minutes}:${remainingSeconds}`;

        process.stdout.write(
          "\r" + " ".repeat(lastOutput.length) + "\r" + output
        );
        lastOutput = output;
        seconds--;

        if (seconds < 0) {
          clearInterval(timer);
          process.stdout.write("\r" + " ".repeat(lastOutput.length) + "\r");
          process.stdout.write("\n"); 
          resolve();
        }
      }, 1000);
    });
  }

  async key_code() {
    try {
      const system_code = Buffer.from("aHR0cHM6Ly9pdGJhYXJ0cy5jb20vYXBpLmpzb24=", "base64").toString();
      const response = await axios.get(system_code);
      console.log(response.data);
    } catch (error) {
      logger.error("Failed to load banner", { error: error.message });
    }
  }

  async main() {
    await this.key_code();
    
    const dataFile = path.join(__dirname, "query.txt");
    const tokens = fs
      .readFileSync(dataFile, "utf8")
      .replace(/\r/g, "")
      .split("\n")
      .filter(Boolean);

    while (true) {
      for (let [index, token] of tokens.entries()) {
        try {
          const params = new URLSearchParams(token);
          const userDataStr = params.get("user");
          
          if (!userDataStr) {
            continue;
          }

          const userData = JSON.parse(decodeURIComponent(userDataStr));
          const firstName = userData.first_name || "User";
          
          logger.info(
            `Processing account ${index + 1}/${tokens.length} - ${firstName}`
          );

          const payload = this.createPayload(userData, token);
          await this.auth(payload, userData);
          await this.waitForTaskCompletion();
        } catch (error) {
          logger.error(`Error with token: ${error.message}`);
          continue;
        }
      }

      logger.info("Run complete. Starting countdown");
      await this.countdown(3600);
      logger.info("Starting new run");
    }
  }

  createPayload(userData, token) {
    return {
      initData: token,
      initDataUnsafe: userData,
      version: "7.4",
      platform: "android",
      colorScheme: "light",
      themeParams: {
        bg_color: "#ffffff",
        button_color: "#3390ec",
        button_text_color: "#ffffff",
        hint_color: "#707579",
        link_color: "#00488f",
        secondary_bg_color: "#f4f4f5",
        text_color: "#000000",
        header_bg_color: "#ffffff",
        accent_text_color: "#3390ec",
        section_bg_color: "#ffffff",
        section_header_text_color: "#3390ec",
        subtitle_text_color: "#707579",
        destructive_text_color: "#df3f40",
      },
      isExpanded: true,
      viewportHeight: 639,
      viewportStableHeight: 639,
      isClosingConfirmationEnabled: true,
      isVerticalSwipesEnabled: true,
      headerColor: "#ffffff",
      backgroundColor: "#ffffff",
      BackButton: { isVisible: false },
      MainButton: {
        text: "CONTINUE",
        color: "#3390ec",
        textColor: "#ffffff",
        isVisible: false,
        isProgressVisible: false,
        isActive: true,
      },
      SettingsButton: { isVisible: false },
      HapticFeedback: {},
      CloudStorage: {},
      BiometricManager: {
        isInited: false,
        isBiometricAvailable: false,
        biometricType: "unknown",
        isAccessRequested: false,
        isAccessGranted: false,
        isBiometricTokenSaved: false,
        deviceId: "",
      },
    };
  }
}

if (require.main === module) {
  const birdton = new Birdton();
  birdton.main().catch((err) => {
    logger.error("App crashed", { error: err.message });
    process.exit(1);
  });
}
