/**
 * RANGKA — diisi oleh issue yang bersangkutan.
 *
 * Sengaja sudah terdaftar di `app.ts` sejak awal supaya enam modul bisa
 * dikerjakan paralel tanpa berebut satu berkas perakitan, dan supaya tes
 * supertest bisa memanggil jalurnya sejak baris pertama ditulis.
 */
import { Router } from "express";

export const tiketRouter: Router = Router();
