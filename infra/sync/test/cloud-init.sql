-- Like Supabase: the app's role owns its database but is not a superuser.
create role postgres login password 'cloud' nosuperuser createdb;
create database cloud owner postgres;
