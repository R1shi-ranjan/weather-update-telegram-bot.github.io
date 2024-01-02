import { Injectable, Logger } from '@nestjs/common';
import * as TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import * as cron from 'node-cron';
import { config } from 'dotenv';
config();
import { AdminService } from './admin/admin.service';
import { UserService } from './user/user.service';

// Interface to represent the expected structure of the weather API response
interface WeatherResponse {
  weather: {
    description: string;
  }[];
  main: {
    temp: number;
  };
}

@Injectable()
export class TelegramBotService {
  private bot: TelegramBot;
  private subscribedUsers: Set<number> = new Set<number>();
  private cityRequests: Map<number, boolean> = new Map<number, boolean>();
  private readonly DEFAULT_CITY = process.env.CITY || 'DefaultCity';

  constructor(
    private readonly adminService: AdminService,
    private readonly userService: UserService,
  ) {
    this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

    this.loadSubscribedUsers();

    this.registerCommands();

    // Schedule the sendWeatherUpdates function to run every hour
    cron.schedule('0 * * * *', () => {
      console.log('Sending weather updates to all subscribed users...');
      this.sendWeatherUpdatesToAll();
    });
  }

  private registerCommands() {
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const { first_name, last_name, username } = msg.from;

      console.log(`User started the bot: ${first_name} ${last_name} (@${username})`);
      this.bot.sendMessage(
        chatId,
        `Hi ${first_name}, welcome to the weather bot. You can subscribe by using the /subscribe command and unsubscribe using /unsubscribe command.`,
      );
    });

    this.bot.onText(/\/subscribe/, async (msg) => {
      const chatId = msg.chat.id;

      if (!this.cityRequests.has(chatId)) {
        this.cityRequests.set(chatId, true);
        this.bot.sendMessage(chatId, 'Enter your city:');
      } else {
        this.bot.sendMessage(chatId, 'You have already requested to enter a city. Please wait for the prompt.');
      }
    });

    this.bot.onText(/\/unsubscribe/, async (msg) => {
      const chatId = msg.chat.id;

      const existingUser = await this.userService.getUserByChatId(chatId);
      if (existingUser) {
        const deletedUser = await this.userService.deleteUser(chatId);
        if (deletedUser) {
          this.subscribedUsers.delete(chatId);
          console.log(`User unsubscribed: } (@${existingUser.username})`);
          this.bot.sendMessage(chatId, 'You have been unregistered.');
        } else {
          this.bot.sendMessage(chatId, 'Unregistration failed. Please try again.');
        }
      } else {
        this.bot.sendMessage(chatId, 'You are not registered.');
      }
    });

    // Handle regular text messages
    this.bot.on('text', async (msg) => {
      const chatId = msg.chat.id;

      if (this.cityRequests.has(chatId)) {
        // User entered a city
        const city = msg.text;
        this.cityRequests.delete(chatId);

        const { id, first_name, last_name, username } = msg.from;
        console.log(`User entered city: ${first_name} ${last_name} (@${username}), City: ${city}`);

        const existingUser = await this.userService.getUserByChatId(chatId);
        if (existingUser) {
          this.bot.sendMessage(chatId, 'You are already registered.');
        } else {
          const user = await this.userService.createUser(id, first_name);
          if (user) {
            this.subscribedUsers.add(chatId);
            this.sendWeatherUpdate(chatId, city);
            console.log(`User registered: ${first_name} ${last_name} (@${username})`);
            this.bot.sendMessage(chatId, 'You have been registered.');
          } else {
            this.bot.sendMessage(chatId, 'Registration failed. Please try again.');
          }
        }
      }
    });
  }

  private async sendWeatherUpdate(chatId: number, city: string) {
    const apiKey = this.adminService.getApiKey();

    try {
      console.log(`Fetching weather data for ${city}...`);
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}`,
      );

      if (!response.ok) {
        Logger.error('Failed to fetch weather data');
        return;
      }

      const data: WeatherResponse = (await response.json()) as WeatherResponse;

      const weatherDescription = data.weather[0]?.description;
      const temperature = (data.main?.temp - 273.15)?.toFixed(2); // Convert to Celsius

      const message = `Weather in ${city}:\n${weatherDescription}\nTemperature: ${temperature}°C`;

      this.bot.sendMessage(chatId, message);
      console.log(`Weather data sent to ${city}.`);
    } catch (error) {
      Logger.error('Error fetching weather data', error);
    }
  }

  private async sendWeatherUpdatesToAll() {
    // This function sends weather updates to all subscribed users
    console.log('Sending weather updates to all subscribed users...');
    for (const chatId of this.subscribedUsers) {
      this.sendWeatherUpdate(chatId, this.DEFAULT_CITY);
    }
    console.log('Weather updates sent to all subscribed users.');
  }

  private async loadSubscribedUsers() {
    const users = await this.userService.getUsers();
    users.forEach((user) => {
      this.subscribedUsers.add(user.chatId);
    });
  }
}
